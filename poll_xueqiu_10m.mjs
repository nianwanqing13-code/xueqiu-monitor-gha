import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendEmail } from './smtp_qq.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 可移植：使用运行本脚本的同一个 node 进程，不再写死 Windows 路径
const NODE = process.execPath;
const FETCH = path.join(__dirname, 'fetch_xueqiu.mjs');
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

async function fetchPosts() {
  // 子进程偶发超时/被强杀时重试 2 次，降低单次抖动导致的漏抓
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const { stdout } = await execFileP(NODE, [FETCH], { env: process.env, timeout: 150000, maxBuffer: 16 * 1024 * 1024 });
      const a = stdout.indexOf('{');
      const b = stdout.lastIndexOf('}');
      if (a < 0 || b < 0) throw new Error('fetch 无 JSON 输出');
      const json = JSON.parse(stdout.slice(a, b + 1));
      if (json.ok && json.posts) return json;
      if (i < 2) { await new Promise(r => setTimeout(r, 3000)); continue; }
      throw new Error(json.reason || '抓取失败');
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

async function runOnce() {
  try {
    const json = await fetchPosts();
    const state = loadState();
    const seen = new Set(state.seen_post_ids || []);
    const fresh = (json.posts || []).filter(p => !seen.has(p.id));
    if (fresh.length === 0) {
      console.log(`[${now()}] 无新帖（本次 ${json.posts.length} 条）`);
      logRun('OK', `无新帖 本次${json.posts.length}条`);
    } else {
      fresh.sort((a, b) => b.created_at - a.created_at); // 新→旧
      prependArchive(fresh);
      for (const p of fresh) seen.add(p.id);
      state.seen_post_ids = [...seen];
      console.log(`[${now()}] 发现 ${fresh.length} 条新帖，已存档`);
      logRun('NEW', `发现${fresh.length}条新帖 已存档`);
      const cfg = loadEmailCfg();
      if (cfg && cfg.user && cfg.pass) {
        try {
          const to = cfg.to || cfg.user;
          const body = fresh.map(p =>
            `${p.time_cst}\n${p.text}\nhttps://xueqiu.com/${USER_ID}/${p.id}`
          ).join('\n\n---\n\n');
          await sendEmail({ user: cfg.user, pass: cfg.pass, to, subject: `雪球新发言：买股票的老木匠（${fresh.length}条）`, text: body });
          console.log(`[${now()}] 已发邮件提醒 -> ${to}`);
          logRun('MAIL', `已发邮件 -> ${to}`);
        } catch (e) {
          console.log(`[${now()}] 邮件发送失败: ${e.message}`);
          logRun('MAIL_FAIL', `邮件发送失败 ${e.message}`);
        }
      } else {
        console.log(`[${now()}] 未配置邮箱，跳过邮件（如需提醒请提供 email.json）`);
      }
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
  // --once：单次运行后立即退出，适合 GitHub Actions cron（每5分钟调度一次）
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
