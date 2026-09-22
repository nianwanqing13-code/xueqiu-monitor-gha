# 雪球监控

监控指定雪球用户的主页时间线：发现新帖自动存档 + 邮件提醒。云部署 / 本地部署通用同一套代码。

**完整说明见上一级目录的 `部署手册.html`（推荐，双击打开）或 `部署手册.md`。**

---

## 快速上手

```bash
npm install
npx playwright install chromium

# 1) 改 xueqiu_sub/config.json 填要监控的 user_id
# 2) 配置邮箱（想收提醒才需要）
cp xueqiu_sub/email.json.example xueqiu_sub/email.json   # 然后编辑填 SMTP 授权码
node test_email.mjs                                      # 验证邮箱

# 3) 跑一次看效果
node poll_xueqiu_10m.mjs --once
```

## 两种部署方式（选一个，别同时开）

```bash
# 云端（GitHub Actions）—— 电脑关机照常跑，推荐
powershell -ExecutionPolicy Bypass -File deploy_github.ps1 -GitHubToken "ghp_xxx" -QQUser "you@qq.com" -QQPass "授权码"

# 本地（Windows 计划任务）—— 每 3 分钟静默运行
powershell -ExecutionPolicy Bypass -File install_windows_task.ps1 -IntervalMinutes 3
```

## 命令速查

```bash
node poll_xueqiu_10m.mjs --once   # 单次运行（交给系统定时器调度，推荐）
node poll_xueqiu_10m.mjs --status # 看健康状态（抓取源/队列/最后成功时间）
node poll_xueqiu_10m.mjs          # 常驻进程，每 10 分钟自查一轮
node fetch_xueqiu_http.mjs        # 只测抓取（纯 HTTP 快路径）
node fetch_xueqiu.mjs             # 只测抓取（浏览器兜底，会刷新 cookie）
node test_email.mjs               # 只测发信
node watchdog.mjs --verbose       # 独立看门狗：从外部读 health.json 判活
```

## 稳定性机制

- **投递队列** `xueqiu_sub/deliveries.json`：通知先入队落盘再发送；失败按 2/4/8/16/32/60 分钟退避重试，
  最多 5 次，超限标记 `dead`（`--status` 会单独列出）。进程被杀、SMTP 抖动都不会丢消息。
- **幂等键 `dedupe_key` + 已通知名单 `notified_ids`**：同一批帖子的通知只入队一次；
  只有**发送成功**才把帖子 ID 记入 `notified_ids`。所以 `state.json` 丢失或被回退也**不会重复发信**。
- **冷数据守卫 `cold_post_hours`（默认 72 小时）**：超过这个时间的旧帖只归档、不发通知，
  防「名单丢失 → 历史倒灌刷屏」；顺带挡掉雪球的置顶老帖。
- **清理只删终态**：裁剪队列时只裁 `sent`/`dead`，`pending` 永不丢 —— 否则清理本身会变成漏通知的原因。
- **健康快照** `xueqiu_sub/health.json`：每轮刷新，记录最后成功检查时间、连续失败数、抓取源状态、
  投递队列统计。`--status` 读的就是它。
- **独立看门狗** `watchdog.mjs`：放在监控之外（另一台机器/另一个调度），按 `health.json` 判活，
  超时未成功检查就发告警邮件；恢复后发「已恢复」。配置见 `xueqiu_sub/watchdog.json.example`。

> ⚠️ 云端部署时 `health.json` 与 `deliveries.json` **必须提交进仓库**（跨运行状态靠它们），
> 否则看门狗会一直认为监控已死。

运行日志在 `xueqiu_sub/run.log`，排查问题先看它。

## 敏感文件（勿提交 / 勿分享）

- `xueqiu_sub/cookies.json` —— 雪球会话 cookie
- `xueqiu_sub/email.json` —— 邮箱与 SMTP 授权码
- `xueqiu_sub/run.log` —— 运行日志
