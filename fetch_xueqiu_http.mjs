// 纯 HTTP 抓取版（无需 Playwright / Chromium）
// 用途：作为 fetch_xueqiu.mjs 的快路径。
// 实测：雪球 timeline 接口只要带上有效 cookie + 常规 UA + X-Requested-With 即可返回 JSON，
//       完全不需要浏览器；快路径失败（cookie 失效 / WAF 挑战）时再回退到 fetch_xueqiu.mjs 走浏览器刷新 cookie。
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const USER_ID = '3058599833';
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
    // 关键：雪球对海外 IP 会把 xueqiu.com 302 到 www.xueqiu.com。
    // 必须跟随重定向，否则只拿到那页 302 的 HTML —— 这正是云端一直失败的原因
    // （2026-09-20 实测：GitHub Actions 出口 IP 请求 xueqiu.com 得 302，请求 www 得 200 + JSON）。
    if (r.status >= 300 && r.status < 400 && r.headers && r.headers.location) {
      const target = new URL(r.headers.location, url).href;
      r = await httpGet(target, cookieHeader(cookies));
    }
    let j = null;
    try { j = JSON.parse(r.body); } catch { /* 非 JSON = 多半是 WAF 挑战页 */ }
    if (j && j.statuses) {
      const posts = j.statuses.map(s => {
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
