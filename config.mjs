// config.mjs — 监控对象配置（云部署 / 本地部署 通用）
//
// 想监控谁，只改 xueqiu_sub/config.json 里的 user_id 就行，不用动任何代码：
//   { "user_id": "3058599833", "user_name": "买股票的老木匠" }
//
// user_id 怎么找：打开对方雪球主页，地址形如 https://xueqiu.com/u/3058599833
//                                                              ^^^^^^^^^^ 这段就是
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = { user_id: '3058599833', user_name: '买股票的老木匠' };

let cfg = { ...DEFAULTS };
try {
  cfg = { ...DEFAULTS, ...JSON.parse(readFileSync(join(__dirname, 'xueqiu_sub', 'config.json'), 'utf8')) };
} catch { /* 没有 config.json 时用默认值 */ }

// 环境变量优先（云端可在 Secrets 里覆盖，不用改仓库文件）
export const USER_ID = String(process.env.XUEQIU_USER_ID || cfg.user_id).trim();
export const USER_NAME = String(cfg.user_name || DEFAULTS.user_name).trim();
export const USER_URL = `https://xueqiu.com/u/${USER_ID}`;
