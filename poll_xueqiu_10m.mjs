// poll_xueqiu_10m.mjs — 轮询主进程（云部署 / 本地部署 通用，同一份代码）
//
// 两种跑法：
//   1) node poll_xueqiu_10m.mjs            → 常驻进程，每 10 分钟自查一轮
//   2) node poll_xueqiu_10m.mjs --once     → 只跑一次就退出，交给系统定时器调度（推荐）
//   3) node poll_xueqiu_10m.mjs --status   → 只打印当前健康状态，不抓取（排查用）
//
// 单轮做的事（顺序很重要）：
//   ① 先补发投递队列里欠的邮件（上轮发失败的这一轮补上）
//   ② 抓取 → 比对 state.json 去重
//   ③ 有新帖/需告警 → 先写入投递队列（落盘），再尝试发送
//   ④ 更新 health.json（心跳、连续失败数、抓取源状态）
//
// 设计要点（稳定性三件套，参考成熟订阅平台的做法）：
//   · 投递队列 deliveries.json —— 抓取与投递解耦，投递有记录、失败自动退避重试，不再发失败就丢
//   · health.json —— 每轮落一份可被外部读取的健康快照，供 watchdog 独立判活
//   · 抓取源状态 —— 连续失败会升级为 degraded/error，恢复时自动回 ok
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendEmail } from './smtp_qq.mjs';
import { USER_ID, USER_NAME } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 可移植：用运行本脚本的同一个 node 进程，不写死任何绝对路径
const NODE = process.execPath;
const FETCH_HTTP = path.join(__dirname, 'fetch_xueqiu_http.mjs'); // 快路径：纯 HTTP，不启浏览器
const FETCH = path.join(__dirname, 'fetch_xueqiu.mjs');           // 兜底：浏览器，可刷新过期 cookie
const STATE = path.join(__dirname, 'xueqiu_sub', 'state.json');
const ARCHIVE = path.join(__dirname, 'xueqiu_sub', 'archive.md');
const EMAIL_CFG = path.join(__dirname, 'xueqiu_sub', 'email.json');
const RUN_LOG = path.join(__dirname, 'xueqiu_sub', 'run.log');
const DELIVERIES = path.join(__dirname, 'xueqiu_sub', 'deliveries.json');
const HEALTH = path.join(__dirname, 'xueqiu_sub', 'health.json');
const INTERVAL_MS = 10 * 60 * 1000;
const LOCK_FILE = path.join(__dirname, 'xueqiu_sub', '.poll_lock');
const LOCK_MAX_AGE = 540 * 1000; // 锁超过 9 分钟视为陈旧自动失效（覆盖最坏抓取时长）

// —— 投递队列参数 ——
const MAX_ATTEMPTS = 5;      // 单封邮件最多尝试 5 次，之后标记 dead（不再无休止重试）
const DELIVERY_KEEP = 200;   // 队列最多保留 200 条记录

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

function loadJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; }
}
function saveJson(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
  catch (e) { logRun('ERROR', `写 ${path.basename(file)} 失败 ${e.message}`); }
}

// ============ ① 投递队列：抓取与投递解耦 ============
// 以前的做法是「抓到就发，发失败只记一行日志」——SMTP 抖一下、授权码过期、网络抽风，
// 这条通知就永久消失了，而且没人知道。现在改成：先落盘入队（status=pending），
// 再尝试发送；失败则按退避重试，直到成功或达到上限（dead，可在队列里看到）。
function loadDeliveries() {
  const d = loadJson(DELIVERIES, null);
  if (!d || !Array.isArray(d.items)) return { items: [] };
  return d;
}
function saveDeliveries(d) {
  if (d.items.length > DELIVERY_KEEP) d.items = d.items.slice(-DELIVERY_KEEP);
  saveJson(DELIVERIES, d);
}

// 退避间隔：第 1 次失败后等 2 分钟，之后 4/8/16/32，最长 60 分钟再试
function backoffMs(attempts) {
  return Math.min(60, Math.pow(2, Math.max(0, attempts - 1)) * 2) * 60 * 1000;
}

function enqueue(subject, text, kind) {
  const d = loadDeliveries();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  d.items.push({
    id, kind, subject, text,
    created_at: now(),
    status: 'pending',
    attempts: 0,
    last_attempt_at: null,
    sent_at: null,
    last_error: null
  });
  saveDeliveries(d);
  return id;
}

async function flushDeliveries() {
  const cfg = loadEmailCfg();
  const d = loadDeliveries();
  const pending = d.items.filter(x => x.status === 'pending');
  if (!pending.length) return { sent: 0, failed: 0, pending: 0 };

  if (!cfg || !cfg.user || !cfg.pass) {
    console.log(`[${now()}] 队列有 ${pending.length} 封待发，但未配置邮箱，保留待发`);
    return { sent: 0, failed: 0, pending: pending.length };
  }

  const to = cfg.to || cfg.user;
  let sent = 0, failed = 0;
  for (const it of pending) {
    // 退避未到就跳过，等下一轮
    if (it.last_attempt_at && Date.now() - Date.parse(it.last_attempt_at) < backoffMs(it.attempts)) continue;

    it.attempts++;
    it.last_attempt_at = now();
    try {
      await sendEmail({ user: cfg.user, pass: cfg.pass, to, subject: it.subject, text: it.text });
      it.status = 'sent';
      it.sent_at = now();
      it.last_error = null;
      sent++;
      console.log(`[${now()}] 邮件已发（第 ${it.attempts} 次尝试）-> ${to}`);
      logRun('MAIL', `${it.kind} 已发（尝试${it.attempts}次）`);
    } catch (e) {
      it.last_error = e.message;
      if (it.attempts >= MAX_ATTEMPTS) {
        it.status = 'dead';
        console.log(`[${now()}] 投递放弃（已试 ${it.attempts} 次）: ${e.message}`);
        logRun('MAIL_FAIL', `投递放弃 已试${it.attempts}次: ${e.message}`);
      } else {
        console.log(`[${now()}] 邮件发送失败（第 ${it.attempts} 次，将自动重试）: ${e.message}`);
        logRun('MAIL_FAIL', `第${it.attempts}次失败 将重试: ${e.message}`);
      }
      failed++;
    }
  }
  saveDeliveries(d);
  const stillPending = loadDeliveries().items.filter(x => x.status === 'pending').length;
  return { sent, failed, pending: stillPending };
}

function deliveryStats() {
  const items = loadDeliveries().items;
  const by = s => items.filter(x => x.status === s).length;
  return { total: items.length, pending: by('pending'), sent: by('sent'), dead: by('dead') };
}

// ============ ② health.json：供外部独立判活 ============
function loadHealth() { return loadJson(HEALTH, {}); }
function saveHealth(obj) {
  saveJson(HEALTH, Object.assign({}, loadHealth(), obj, { updated_at: now() }));
}

// ============ ③ 抓取源状态 ============
// 连续失败会升级状态，恢复时自动回到 ok。让「这个源坏了」变成可观测的事实，
// 而不是埋在日志里的一行 catch。
function sourceStatusFromFailures(n) {
  if (n <= 0) return 'ok';
  if (n < 3) return 'degraded';
  return 'error';
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
// （PC 关机休眠 / 云端抓取持续失败），必须让用户知道，否则会静默漏抓好几天。
const GAP_WARN_MIN = 30;    // 超过 30 分钟：在邮件顶部加中断提示
const GAP_NOTIFY_MIN = 30;  // 超过 30 分钟且本轮无新帖：单独发一封「已恢复」通知

function fmtGap(min) {
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `${d} 天 ${hh} 小时` : `${d} 天`;
}

async function runOnce() {
  // ① 先把上一轮欠下的投递补发掉
  try {
    const r = await flushDeliveries();
    if (r.sent || r.failed) logRun('QUEUE', `补发 sent=${r.sent} failed=${r.failed} pending=${r.pending}`);
  } catch (e) {
    logRun('QUEUE_FAIL', `补发异常 ${e.message}`);
  }

  let fetchOk = false, errMsg = null;
  try {
    const json = await fetchPosts();
    fetchOk = true;

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
        enqueue(
          `${USER_NAME}监控已恢复（此前中断约 ${fmtGap(gapMin)}）`,
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
      enqueue(
        `雪球新发言：${USER_NAME}（${fresh.length}条）`,
        gapNote + body,
        `新帖(${fresh.length}条)`
      );
    }
    state.last_check = now();
    saveState(state);
  } catch (e) {
    errMsg = e.message || String(e);
    // 抓取整体失败（WAF 拦截 / 网络异常 / 重试耗尽）：记录但不退出，等下一轮
    console.log(`[${now()}] 本轮失败: ${errMsg}`);
    logRun('FAIL', `本轮失败 ${errMsg}`);
  }

  // ④ 更新健康快照
  const h = loadHealth();
  const failures = fetchOk ? 0 : (Number(h.consecutive_failures) || 0) + 1;
  const st = deliveryStats();
  saveHealth({
    last_run_at: now(),
    last_success_at: fetchOk ? now() : (h.last_success_at || null),
    last_fetch_ok: fetchOk,
    consecutive_failures: failures,
    source_status: sourceStatusFromFailures(failures),
    last_error: fetchOk ? null : errMsg,
    deliveries: st,
    seen_count: (loadState().seen_post_ids || []).length,
    monitor: { user_id: USER_ID, user_name: USER_NAME }
  });

  // 本轮新入队的通知，抓取成功后立刻尝试发一次（不等下一轮）
  if (fetchOk) {
    try { await flushDeliveries(); } catch (e) { logRun('QUEUE_FAIL', `即时发送异常 ${e.message}`); }
    saveHealth({ deliveries: deliveryStats() });
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

// —— --status：一眼看清监控现在是什么状态（排查/巡检用） ——
function printStatus() {
  const h = loadHealth();
  const st = deliveryStats();
  const ago = ts => {
    if (!ts) return '从未';
    const min = Math.round((Date.now() - Date.parse(ts)) / 60000);
    return `${min} 分钟前（${ts}）`;
  };
  const icon = { ok: 'OK', degraded: '注意', error: '异常' }[h.source_status] || '未知';
  console.log('=== 雪球监控状态 ===');
  console.log(`监控对象     : ${h.monitor ? `${h.monitor.user_name} (${h.monitor.user_id})` : `${USER_NAME} (${USER_ID})`}`);
  console.log(`抓取源状态   : ${icon}  (连续失败 ${h.consecutive_failures || 0} 次)`);
  console.log(`最后成功检查 : ${ago(h.last_success_at)}`);
  console.log(`最后运行     : ${ago(h.last_run_at)}`);
  if (h.last_error) console.log(`最近错误     : ${h.last_error}`);
  console.log(`投递队列     : 待发 ${st.pending} / 已发 ${st.sent} / 放弃 ${st.dead}（共 ${st.total} 条）`);
  console.log(`已读帖子数   : ${h.seen_count || (loadState().seen_post_ids || []).length}`);
  const dead = loadDeliveries().items.filter(x => x.status === 'dead');
  if (dead.length) {
    console.log('--- 已放弃的投递（需人工介入）---');
    for (const x of dead.slice(-5)) console.log(`  ${x.created_at}  ${x.subject}  最后错误: ${x.last_error}`);
  }
}

async function main() {
  if (process.argv.includes('--status')) { printStatus(); process.exit(0); }

  // --once：单次运行后立即退出，适合 cron / systemd timer / Windows 任务计划
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
