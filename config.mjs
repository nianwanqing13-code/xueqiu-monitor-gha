// config.mjs — 监控对象与运行参数配置（云 / 本地通用）
//
// 改监控对象、调参数都在 xueqiu_sub/config.json 里改，不用动代码。
// 也支持用环境变量临时覆盖（云端 Secrets 里可以改）。
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  user_id: '3058599833',
  user_name: '买股票的老木匠',
  // 冷数据守卫：帖子发布时间超过这个小时数就只归档、不发即时通知。
  // 用途 —— 万一 state.json 丢失/回退导致旧帖被当成新帖重新识别，不会把历史一次全倒灌进你邮箱。
  cold_post_hours: 72
};

let cfg = { ...DEFAULTS };
try {
  const raw = JSON.parse(readFileSync(join(__dirname, 'xueqiu_sub', 'config.json'), 'utf8'));
  cfg = { ...DEFAULTS, ...raw };
} catch { /* 无 config.json 时用默认（老木匠） */ }

export const USER_ID = String(process.env.XUEQIU_USER_ID || cfg.user_id).trim();
export const USER_NAME = String(cfg.user_name || DEFAULTS.user_name);
export const USER_URL = `https://xueqiu.com/u/${USER_ID}`;
export const COLD_POST_HOURS = Number(process.env.COLD_POST_HOURS || cfg.cold_post_hours || DEFAULTS.cold_post_hours);
export const STORE_DIR = join(__dirname, 'xueqiu_sub');
