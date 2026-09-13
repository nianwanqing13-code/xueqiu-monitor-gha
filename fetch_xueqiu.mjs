import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const USER_ID = '3058599833';
const USER_URL = `https://xueqiu.com/u/${USER_ID}`;
const COOKIE_FILE = join(__dirname, 'xueqiu_sub', 'cookies.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function loadCookies() {
  try { return JSON.parse(readFileSync(COOKIE_FILE, 'utf8')); } catch { return []; }
}
function saveCookies(cookies) {
  try { writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2)); } catch {}
}

async function callApi(page) {
  const txt = await page.evaluate(async (uid) => {
    const resp = await fetch(`https://xueqiu.com/statuses/user_timeline.json?user_id=${uid}&page=1&size=20&type=status&_=${Date.now()}`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' },
      credentials: 'include'
    });
    return await resp.text();
  }, USER_ID);
  try { return JSON.parse(txt); } catch { return null; }
}

// 单次抓取尝试：优先复用 cookie（快路径），失败再翻 WAF 刷新 cookie（慢路径）
async function tryFetch(browser, savedCookies) {
  let data = null;
  if (savedCookies.length) {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'zh-CN' });
    await ctx.addCookies(savedCookies);
    const page = await ctx.newPage();
    try {
      await page.goto(USER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      data = await callApi(page);
    } catch { data = null; }
    await ctx.close();
  }
  if (!data || !data.statuses) {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'zh-CN' });
    const page = await ctx.newPage();
    try {
      await page.goto(USER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector(`a[href*="/${USER_ID}/"]`, { timeout: 45000 });
      await page.waitForTimeout(2000);
      const fresh = await ctx.cookies();
      if (fresh.length) saveCookies(fresh);
      data = await callApi(page);
    } catch { data = null; }
    await ctx.close();
  }
  return data;
}

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
});

let data = null;
const saved = loadCookies();
// 整轮重试：网络抖动 / WAF 偶发拦截时最多再试 2 次（共 3 次），避免偶发失败漏抓
for (let attempt = 1; attempt <= 3 && !(data && data.statuses); attempt++) {
  try {
    data = await tryFetch(browser, saved.length ? saved : loadCookies());
  } catch { /* 单次失败继续重试 */ }
  if (!(data && data.statuses) && attempt < 3) {
    await new Promise(r => setTimeout(r, 4000));
  }
}

await browser.close();

if (data && data.statuses) {
  const posts = data.statuses.map(s => {
    const txt = String(s.text || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    const ms = Number(s.created_at);
    const bj = new Date(ms + 8 * 3600 * 1000);
    const pad = n => String(n).padStart(2, '0');
    const time_cst = `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`;
    // 不再截断正文：雪球 timeline 接口返回的就是全文（已实测，最长 1391 字与 show.json 一致）。
    return { id: String(s.id), created_at: ms, time_cst, text: txt };
  });
  console.log(JSON.stringify({ ok: true, count: posts.length, posts }, null, 2));
} else {
  console.log(JSON.stringify({ ok: false, reason: 'no statuses (WAF blocked or network error)' }, null, 2));
}
