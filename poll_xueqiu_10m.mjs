import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendEmail } from './smtp_qq.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 可移植：使用运行本脚本的同一个 node 进程，不再写死 Windows 路径
const NODE = process.execPath;
const FETCH_HTTP = path.join(__dirname, 'fetch_xueqiu_http.mjs'); // 快路径：纯 HTTP，不启浏览器
const FETCH = path.join(__dirname, 'fetch_xueqiu.mjs');           // 兜底：浏览器，可刷新过期 cookie
const STATE = path.join(__dirname, 'xueqiu_sub', 'state.json');
const ARCHIVE = path.join(__dirname, 'xueqiu_sub', 'archive.md');
const EMAIL_CFG = path.join(__dirname, 'xueqiu_sub', 'email.json');
const RUN_LOG = path.join(__dirname, 'xueqiu_sub', 'run.log');
const USER_ID = '3058599833';
const INTERVAL_MS = 10 * 60 * 1000;
const LOCK_FILE = path.join(__dirname, 'xueqiu_sub', '.poll_lock');
const LOCK_MAX_AGE = 540 * 1000; // 锁超过 9 分钟视为陈旧自动失效（覆盖最坏抓取时长）

const execFileP = promisify(execFile);
const now = () => new Date().toISOString();
const cst = () => {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

// 运行审计日志：每次运行结果写 run.log，便于事后追溯哪些时段失败/为何失败
function logRun(level, msg) {
  try { fs.appendFileSync(RUN_LOG, `${cst()} [${level}] ${msg}\n`); } catch { /* 写日志失败不影响主流程 */ }
}

// 跑单个 fetch 脚本并解析其 JSON 输出
async function runFetchScript(script, timeout) {
  const { stdout } = await execFileP(NODE, [script], { env: process.env, timeout, maxBuffer: 16 * 1024 * 1024 });
  const a = stdout.indexOf('{');
  const b = stdout.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('fetch 无 JSON 输出');
  const json = JSON.parse(stdout.slice(a, b + 1));
  if (json.ok && json.posts) return json;
  throw new Error(json.reason || '抓取失败');
}

async function fetchPosts() {
  // 快路径：纯 HTTP 请求（秒级完成，不启浏览器 —— 资源占用与指纹暴露都最小）
  try {
    return await runFetchScript(FETCH_HTTP, 40000);
  } catch { /* 失败则落到浏览器路径（能刷新过期 cookie / 过 WAF 挑战） */ }

  // 慢路径：浏览器抓取；子进程偶发超时/被强杀时重试，降低单次抖动导致的漏抓
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return await runFetchScript(FETCH, 150000);
    } catch (e) {
      lastErr = e;
      if (i < 2) await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { seen_post_ids: [] }; }
}
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }

function prependArchive(posts) {
  let block = '';
  for (const p of posts) {
    block += `## ${p.time_cst}（新帖）\n- **链接**: https://xueqiu.com/${USER_ID}/${p.id}\n- **正文**: ${p.text}\n\n`;
  }
  let cur = fs.readFileSync(ARCHIVE, 'utf8');
  const idx = cur.indexOf('\n---');
  if (idx === -1) cur = cur + '\n---\n' + block;
  else cur = cur.slice(0, idx + 4) + '\n' + block + cur.slice(idx + 4);
  fs.writeFileSync(ARCHIVE, cur);
}

function loadEmailCfg() {
  try { return JSON.parse(fs.readFileSync(EMAIL_CFG, 'utf8')); } catch { return null; }
}

// —— 断档检测 ——
// 正常节奏约 3 分钟一轮。若「上次成功检查」距今明显超出，说明监控中断过
// （PC 关机休眠 / 云端抓取持续失败），必须让用户知道，否则会像 9/16 那次静默漏 4 天。
const GAP_WARN_MIN = 30;    // 超过 30 分钟：在邮件顶部加中断提示
const GAP_NOTIFY_MIN = 30;  // 超过 30 分钟且本轮无新帖：单独发一封「已恢复」通知（PC 睡眠/关机也会触发）

function fmtGap(min) {
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `${d} 天 ${hh} 小时` : `${d} 天`;
}

async function notify(subject, text, tag) {
  const cfg = loadEmailCfg();
  if (!cfg || !cfg.user || !cfg.pass) {
    console.log(`[${now()}] 未配置邮箱，跳过邮件（如需提醒请提供 email.json）`);
    return;
  }
  const to = cfg.to || cfg.user;
  try {
    await sendEmail({ user: cfg.user, pass: cfg.pass, to, subject, text });
    console.log(`[${now()}] 已发邮件提醒 -> ${to}`);
    logRun('MAIL', `${tag} -> ${to}`);
  } catch (e) {
    console.log(`[${now()}] 邮件发送失败: ${e.message}`);
    logRun('MAIL_FAIL', `邮件发送失败 ${e.message}`);
  }
}

async function runOnce() {
  try {
    const json = await fetchPosts();
    const state = loadState();
    const seen = new Set(state.seen_post_ids || []);
    const fresh = (json.posts || []).filter(p => !seen.has(p.id));

    // 断档检测：对比「上次成功检查」，识别 PC 关机 / 云端抓取失败造成的监控空窗
    const prevMs = state.last_check ? Date.parse(state.last_check) : 0;
    const gapMin = prevMs ? Math.round((Date.now() - prevMs) / 60000) : 0;
    const gapNote = gapMin >= GAP_WARN_MIN
      ? `⚠️ 监控中断提示：上次成功检查在 ${fmtGap(gapMin)} 前（正常约 3 分钟一轮），期间可能漏抓。\n`
        + `雪球接口只开放最新 20 条发言，更早的无法回溯补档，请留意。\n\n`
      : '';

    if (fresh.length === 0) {
      console.log(`[${now()}] 无新帖（本次 ${json.posts.length} 条）`);
      logRun('OK', `无新帖 本次${json.posts.length}条`);
      // 长时间断档后即使没有新帖也告知一声，避免静默失效无人察觉
      if (gapMin >= GAP_NOTIFY_MIN) {
        await notify(
          `雪球监控已恢复（此前中断约 ${fmtGap(gapMin)}）`,
          `${gapNote}本次检查未发现新帖。\n\n检查时间：${cst()}`,
          `断档恢复通知(${fmtGap(gapMin)})`
        );
      }
    } else {
      fresh.sort((a, b) => b.created_at - a.created_at); // 新→旧
      prependArchive(fresh);
      for (const p of fresh) seen.add(p.id);
      state.seen_post_ids = [...seen];
      console.log(`[${now()}] 发现 ${fresh.length} 条新帖，已存档`);
      logRun('NEW', `发现${fresh.length}条新帖 已存档`);
      const body = fresh.map(p =>
        `${p.time_cst}\n${p.text}\nhttps://xueqiu.com/${USER_ID}/${p.id}`
      ).join('\n\n---\n\n');
      await notify(
        `雪球新发言：买股票的老木匠（${fresh.length}条）`,
        gapNote + body,
        `已发邮件(${fresh.length}条)`
      );
    }
    state.last_check = now();
    saveState(state);
  } catch (e) {
    // 抓取整体失败（WAF 拦截 / 网络异常 / 重试耗尽）：记录但不退出，等下一轮
    console.log(`[${now()}] 本轮失败: ${e.message || e}`);
    logRun('FAIL', `本轮失败 ${e.message || e}`);
  }
}

// 并发锁：防止两次调度重叠导致 state.json / archive.md 写入竞争（间隔缩短后更关键）
function takeLock() {
  try {
    const st = fs.statSync(LOCK_FILE);
    if (Date.now() - st.mtimeMs < LOCK_MAX_AGE) return false; // 仍被其它实例持有
    fs.unlinkSync(LOCK_FILE); // 陈旧锁，清理后重新获取
  } catch { /* 无锁文件，可直接获取 */ }
  let fd;
  try { fd = fs.openSync(LOCK_FILE, 'wx'); } // 原子创建，已存在则失败
  catch { return false; }
  try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch {}
  try { if (typeof fd === 'number') fs.closeSync(fd); } catch {}
  return true;
}
function releaseLock() { try { fs.unlinkSync(LOCK_FILE); } catch {} }

async function main() {
  // --once：单次运行后立即退出，适合 GitHub Actions 长循环（每3分钟一轮）
  if (process.argv.includes('--once')) {
    console.log(`[${now()}] --once 单次运行`);
    if (!takeLock()) {
      console.log(`[${now()}] 已有实例运行中（锁占用），跳过本次`);
      logRun('SKIP', '锁被占用，跳过本次');
      process.exit(0);
    }
    logRun('RUN', '启动 --once');
    try { await runOnce(); }
    finally { releaseLock(); }
    console.log(`[${now()}] 单次运行结束`);
    logRun('RUN', '结束 --once');
    process.exit(0);
  }
  console.log(`[${now()}] 10 分钟轮询进程启动 (pid=${process.pid})`);
  logRun('RUN', `常驻进程启动 pid=${process.pid}`);
  while (true) {
    try { await runOnce(); }
    catch (e) { console.log(`[${now()}] 迭代异常: ${e.stack || e}`); logRun('ERROR', e.stack || String(e)); }
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
}
main();
