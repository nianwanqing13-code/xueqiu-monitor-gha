# 雪球监控（买股票的老木匠 UID 3058599833）· GitHub Actions 版

把抓取调度搬到 GitHub 服务器，**本地 PC 关机/休眠也不中断**。抓取逻辑沿用你已在 PC 上验证过的 Playwright + 零依赖 QQ SMTP 方案，只是把"调度器"从 Windows 任务计划换成 GitHub 的 cron。状态（已读帖 ID、存档）回写进仓库，跨运行不丢。

## 原理
- 调度：`on.schedule` 外层每 5 分钟触发一次（`*/5`）。**GitHub Actions 官方 cron 最小粒度是 5 分钟**，故任务内跑两次抓取、中间 `sleep 180`，使两次检查间隔 ≤3 分钟（满足"3 分钟"要求，且不依赖 GitHub cron 的亚 5 分钟支持）。全程跑在 GitHub 的 Ubuntu 容器里，与本地 PC 开关机无关。
- 抓取：`fetch_xueqiu.mjs` 用 Playwright 加载雪球主页、调用 `user_timeline.json` 拿最新发言。
- 去重+存档：`poll_xueqiu_10m.mjs` 比对 `state.json` 的 `seen_post_ids`，新帖写入 `archive.md`。
- 邮件：复用 `smtp_qq.mjs`，直接 QQ SMTP 发到你的邮箱（无需第三方服务）。
- 持久化：每次运行后把 `state.json` / `archive.md` `git commit` 回仓库，下一轮接着用。

## 成本与仓库可见性（重要）
- **公开库 = 无限免费分钟**：建议把仓库设为 **Public**。这样 3 分钟 24/7 完全免费。仓库里只有老木匠的公开帖存档 + 状态文件，**不含任何 secret**（cookie/邮箱都在 GitHub Secrets 里，不入库），隐私无虞。
- **私有库**：免费额度仅 **2000 分钟/月**。本方案每次任务约 18 分钟 runner 时间（两次抓取 + 3 分钟等待），私有库免费额度约只能撑 **每天 ~9 小时** 的 3 分钟监控。若要 24/7 又不想公开，要么付费买 Actions 分钟，要么退回 5 分钟粒度 / 仅交易时段运行。

## 部署步骤（一次性，一键脚本）

在 `xueqiu-gha` 目录下，用 PowerShell 跑一条命令即可全自动完成「建库 + 推代码 + 设 4 个 Secrets + 启用 workflow」：

```powershell
.\deploy.ps1 -GitHubToken "ghp_你的Token" -QQPass "你的QQ邮箱SMTP授权码"
```

- `-GitHubToken`：GitHub Personal Access Token（勾选 `repo` + `workflow` 权限），在 https://github.com/settings/tokens 生成。
- `-QQPass`：QQ 邮箱 **SMTP 授权码**（不是登录密码）。本地 `email.json` 里该项为空，必须填。
- 仓库默认 **Public**（无限免费分钟，见下）。要私有加 `-Visibility private`。
- 脚本自动从 `../xueqiu_sub/cookies.json` 读取 cookie，无需手动复制。

跑完它会提示最后一步：停掉 PC 上的 `XueqiuMonitor_3min` 任务防双发：

```powershell
schtasks /Delete /TN XueqiuMonitor_3min /F
```

### 手动兜底（若一键脚本失败）
1. 在 GitHub 新建仓库（建议 Public），把本目录全部内容 push 上去。
2. `Settings → Secrets and variables → Actions → New repository secret` 添加 4 个：`XUEQIU_COOKIES`（PC 上 `Claw/xueqiu_sub/cookies.json` 全文）、`QQ_USER=3196846119@qq.com`、`QQ_PASS`、`EMAIL_TO=3196846119@qq.com`。
3. `Actions` 页面手动 `Run workflow` 验证一次。
4. 停掉 PC 的 `XueqiuMonitor_3min` 任务。

## 日常维护
- **cookie 过期**：雪球 cookie 会失效（几天~几周）。失效后 run.log（仓库里）会报 `WAF blocked` 或邮件停发。届时重新从雪球网页抓一份 cookie，更新 `XUEQIU_COOKIES` secret 即可，不用改代码。
- **GitHub 自动停用**：仓库 60 天无活动，GitHub 会停用定时 workflow。保持仓库有提交即可（本监控每次运行都会 commit，通常自动续命）；若被停用，去 Actions 页面手动启用。
- **频率**：本方案等效 **≤3 分钟** 检查间隔（外层 `*/5` 触发 + 任务内 sleep 180 再查一次）。比本地 3 分钟任务计划体验一致。

## 文件说明
- `fetch_xueqiu.mjs` / `poll_xueqiu_10m.mjs` / `smtp_qq.mjs`：与 PC 版逻辑一致（已验证），仅调度方式不同。
- `.github/workflows/xueqiu-monitor.yml`：云端调度定义。
- `xueqiu_sub/state.json`、`archive.md`：运行时持久化（回写仓库）。
- `cookies.json` / `email.json` / `run.log`：由 Secrets 在运行时生成，**不入库**（见 `.gitignore`）。
