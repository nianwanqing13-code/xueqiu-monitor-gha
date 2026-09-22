// fetch_xueqiu_http.mjs — 纯 HTTP 抓取（快路径，不需要浏览器）
//
// 实测结论：雪球的 user_timeline.json 接口只要带上 cookie + 常规 UA + X-Requested-With，
// 就直接返回 JSON，完全不用开浏览器（一轮约 1 秒，而浏览器要 5 秒以上）。
//
// ⚠️ 关键坑（2026-09-20 定位）：雪球对「海外 IP」会把 xueqiu.com 302 重定向到 www.xueqiu.com。
//    如果代码不跟随重定向，就只能拿到那个 302 页的 HTML，JSON 解析必然失败 ——
//    这正是监控在 GitHub Actions 上「静默失效 4 天」的真正原因。
//    所以下面必须跟随一次重定向（重带 cookie）。
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import https from 'https';
import { USER_ID } from './config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIE_FILE = join(__dirname, 'xueqiu_sub', 'cookies.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function loadCookies() {
  try { return JSON.parse(readFileSync(COOKIE_FILE, 'utf8')); } catch { return []; }
}

function cookieHeader(list) {
  return list
    .filter(c => typeof c.domain === 'string' && c.domain.includes('xueqiu'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

function httpGet(url, cookie, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Cookie': cookie,
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `https://xueqiu.com/u/${USER_ID}`
      },
      timeout: timeoutMs
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const cookies = loadCookies();
let result = { ok: false, reason: 'no cookies' };

if (cookies.length) {
  const url = `https://xueqiu.com/statuses/user_timeline.json?user_id=${USER_ID}&page=1&size=20&type=status&_=${Date.now()}`;
  try {
    let r = await httpGet(url, cookieHeader(cookies));

    // 跟随重定向（海外 IP 场景必需，见文件头说明）
    if (r.status >= 300 && r.status < 400 && r.headers && r.headers.location) {
      const target = new URL(r.headers.location, url).href;
      r = await httpGet(target, cookieHeader(cookies));
    }

    let j = null;
    try { j = JSON.parse(r.body); } catch { /* 非 JSON = 多半是 WAF 挑战页 */ }
    if (j && j.statuses) {
      const posts = j.statuses.map(s => {
        // 不截断正文：timeline 接口返回的就是全文（已实测，最长 1391 字）
        const txt = String(s.text || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        const ms = Number(s.created_at);
        const bj = new Date(ms + 8 * 3600 * 1000);
        const pad = n => String(n).padStart(2, '0');
        const time_cst = `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`;
        return { id: String(s.id), created_at: ms, time_cst, text: txt };
      });
      result = { ok: true, count: posts.length, posts, via: 'http' };
    } else {
      result = { ok: false, reason: `http ${r.status} / ${(j && (j.error_code || j.error_description)) || 'non-json (WAF?)'}` };
    }
  } catch (e) {
    result = { ok: false, reason: `http error: ${e.message}` };
  }
}

console.log(JSON.stringify(result, null, 2));
