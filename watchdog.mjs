// watchdog.mjs —— 独立看门狗：从「外面」判断监控还活着没有
//
// 为什么需要它？
//   监控脚本自己发的告警邮件，前提是监控脚本还能跑。如果整条链路死了
//   （GitHub workflow 被停用 / 自我接力断了 / 服务器挂了 / 任务被删了），
//   就永远不会有人告诉你 —— 上次就是这样静默漏抓了 4 天。
//
// 所以看门狗必须满足两个条件：
//   1) 跑在监控之外（另一台机器 / 另一个调度），不受监控链路影响；
//   2) 判活依据是监控留下的「健康快照」health.json，而不是监控自己报平安。
//
// 用法：
//   node watchdog.mjs                 # 检查一次，异常就发告警邮件，正常就静默
//   node watchdog.mjs --verbose       # 无论正常与否都打印判断过程
//
// 配置 xueqiu_sub/watchdog.json：
//   {
//     "health_url": "https://raw.githubusercontent.com/你/仓库/main/xueqiu_sub/health.json",
//     "stale_minutes": 30,     // 超过多少分钟没有成功检查就告警
//     "realert_hours": 6,      // 持续异常时，最多每 6 小时提醒一次，避免轰炸
//     "label": "雪球监控"
//   }
//
// 提示：health_url 也可以填本地文件路径（本地部署时用），例如 "xueqiu_sub/health.json"。
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import { sendEmail } from './smtp_qq.mjs';
import { USER_NAME } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUB = path.join(__dirname, 'xueqiu_sub');
const CFG_FILE = path.join(SUB, 'watchdog.json');
const EMAIL_CFG = path.join(SUB, 'email.json');
const STATE_FILE = path.join(SUB, 'watchdog_state.json');
const RUN_LOG = path.join(SUB, 'run.log');

const VERBOSE = process.argv.includes('--verbose');
const DEFAULT_CFG = { health_url: '', stale_minutes: 30, realert_hours: 6, label: `${USER_NAME}监控` };

const now = () => new Date().toISOString();
const cst = () => {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};
const say = m => { console.log(m); try { fs.appendFileSync(RUN_LOG, `${cst()} [WATCHDOG] ${m}\n`); } catch {} };

function loadJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }
function saveJson(f, o) { try { fs.writeFileSync(f, JSON.stringify(o, null, 2)); } catch {} }

function fmtGap(min) {
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `${d} 天 ${hh} 小时` : `${d} 天`;
}

// 取健康快照：支持 http(s) 远程 URL 与本地文件路径
function fetchHealth(url, token) {
  return new Promise((resolve, reject) => {
    if (/^https?:\/\//i.test(url)) {
      const lib = url.startsWith('https') ? https : http;
      const headers = { 'User-Agent': 'xueqiu-watchdog', 'Cache-Control': 'no-cache' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const req = lib.get(url, { headers, timeout: 20000 }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', c => { data += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(data)); } catch { reject(new Error('返回内容不是 JSON')); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    } else {
      const p = path.isAbsolute(url) ? url : path.join(__dirname, url);
      try { resolve(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch (e) { reject(new Error(`读本地文件失败: ${e.message}`)); }
    }
  });
}

async function main() {
  const cfg = Object.assign({}, DEFAULT_CFG, loadJson(CFG_FILE, {}));
  // 允许用环境变量覆盖（云端工作流里会用它指向仓库内的 health.json）
  if (process.env.WATCHDOG_HEALTH_URL) cfg.health_url = process.env.WATCHDOG_HEALTH_URL;
  if (process.env.WATCHDOG_STALE_MINUTES) cfg.stale_minutes = Number(process.env.WATCHDOG_STALE_MINUTES);
  if (!cfg.health_url) {
    console.error('未配置 xueqiu_sub/watchdog.json 的 health_url，无法判活。');
    console.error('示例：{ "health_url": "https://raw.githubusercontent.com/你/仓库/main/xueqiu_sub/health.json", "stale_minutes": 30 }');
    process.exit(2);
  }
  const token = process.env.GITHUB_TOKEN || '';
  const emailCfg = loadJson(EMAIL_CFG, null);
  const st = Object.assign({ alerted: false, last_alert_at: null, last_ok_at: null }, loadJson(STATE_FILE, {}));

  let health = null, probeErr = null;
  try {
    health = await fetchHealth(cfg.health_url, token);
  } catch (e) {
    probeErr = e.message;
  }

  // 判断是否「不健康」
  let staleMin = null, unhealthy = false, reason = '';
  if (probeErr) {
    unhealthy = true;
    reason = `读不到健康快照（${probeErr}）`;
  } else {
    const lastOk = health.last_success_at ? Date.parse(health.last_success_at) : 0;
    staleMin = lastOk ? Math.round((Date.now() - lastOk) / 60000) : null;
    if (!lastOk) {
      unhealthy = true;
      reason = '健康快照里没有记录过任何一次成功检查';
    } else if (staleMin > cfg.stale_minutes) {
      unhealthy = true;
      reason = `已 ${fmtGap(staleMin)} 没有成功的抓取检查（阈值 ${cfg.stale_minutes} 分钟）`;
    }
    // 补充信息：源自身报的连续失败
    if (!unhealthy && health.consecutive_failures > 0) {
      reason = `抓取连续失败 ${health.consecutive_failures} 次（状态 ${health.source_status}）`;
    }
  }

  const detail = health ? [
    `抓取源状态   : ${health.source_status || '未知'}（连续失败 ${health.consecutive_failures || 0} 次）`,
    `最后成功检查 : ${health.last_success_at ? `${staleMin} 分钟前（${health.last_success_at}）` : '从未'}`,
    `最后运行     : ${health.last_run_at || '未知'}`,
    health.last_error ? `监控自报错误 : ${health.last_error}` : '',
    health.deliveries ? `投递队列     : 待发 ${health.deliveries.pending || 0} / 已发 ${health.deliveries.sent || 0} / 放弃 ${health.deliveries.dead || 0}` : ''
  ].filter(Boolean).join('\n') : `读取失败原因: ${probeErr}`;

  if (VERBOSE) say(unhealthy ? `[告警] ${reason}` : `[正常] 最近一次成功检查在 ${staleMin} 分钟前`);

  const canAlert = emailCfg && emailCfg.user && emailCfg.pass;
  const realertMs = Math.max(1, Number(cfg.realert_hours) || 6) * 3600 * 1000;

  if (unhealthy) {
    const sinceLastAlert = st.last_alert_at ? Date.now() - Date.parse(st.last_alert_at) : Infinity;
    // 首次告警立即发；持续异常则按 realert_hours 限流，避免刷屏
    if (!st.alerted || sinceLastAlert >= realertMs) {
      if (canAlert) {
        try {
          await sendEmail({
            user: emailCfg.user, pass: emailCfg.pass, to: (emailCfg.to || emailCfg.user),
            subject: `⚠️【告警】${cfg.label}疑似中断`,
            text:
              `${cfg.label} 看门狗在 ${cst()} 判定监控处于异常状态：\n\n` +
              `判定依据：${reason}\n\n` +
              `--- 健康快照 ---\n${detail}\n\n` +
              `这封邮件由看门狗独立发出（不依赖监控本身），所以只要它还能发，就说明监控确实出问题了。\n` +
              `请检查：云端在仓库 Actions 页看最近的 run 是否还在跑；本地看计划任务是否还在、电脑是否关机。\n`
          });
          say(`已发告警邮件: ${reason}`);
          st.last_alert_at = now(); st.alerted = true;
        } catch (e) {
          say(`告警邮件发送失败: ${e.message}`);
        }
      } else {
        say(`判定异常（${reason}），但未配置邮箱，无法告警`);
      }
    } else {
      if (VERBOSE) say(`异常持续中，距上次告警不足 ${cfg.realert_hours} 小时，本次不重复发送`);
    }
  } else {
    if (st.alerted) {
      if (canAlert) {
        try {
          await sendEmail({
            user: emailCfg.user, pass: emailCfg.pass, to: (emailCfg.to || emailCfg.user),
            subject: `✅【恢复】${cfg.label}已恢复正常`,
            text:
              `看门狗在 ${cst()} 确认监控已恢复正常。\n\n` +
              `最近一次成功检查：${staleMin} 分钟前\n\n` +
              `--- 健康快照 ---\n${detail}\n`
          });
          say('监控已恢复，已发恢复通知');
        } catch (e) { say(`恢复邮件发送失败: ${e.message}`); }
      }
      st.alerted = false; st.last_alert_at = null;
    }
    st.last_ok_at = now();
    if (VERBOSE) say('监控正常');
  }

  saveJson(STATE_FILE, st);
  process.exit(0);
}

main().catch(e => { say(`看门狗自身异常: ${e.message}`); process.exit(1); });
