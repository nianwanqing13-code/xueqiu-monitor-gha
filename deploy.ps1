# deploy.ps1 — One-shot deployment of xueqiu-gha to GitHub Actions.
# Runs entirely on GitHub servers afterwards (PC off => still crawls).
#
# USAGE (run from inside the xueqiu-gha folder):
#   .\deploy.ps1 -GitHubToken "ghp_xxxx" -QQPass "你的QQ邮箱SMTP授权码"
#
# You only supply TWO things:
#   1) GitHubToken : a GitHub Personal Access Token with "repo" + "workflow" scopes
#                    (https://github.com/settings/tokens)
#   2) QQPass      : your QQ mailbox SMTP authorization code (the local email.json has it empty)
#
# Repo is PUBLIC by default => unlimited free Actions minutes (24/7 @ 3 min).
# To keep it private (free tier ~2000 min/month, enough ~9h/day): -Visibility private
param(
  [Parameter(Mandatory=$true)][string]$GitHubToken,
  [Parameter(Mandatory=$true)][string]$QQPass,
  [string]$RepoName = "xueqiu-monitor-gha",
  [ValidateSet("public","private")][string]$Visibility = "public"
)
$ErrorActionPreference = "Stop"
$base = $PSScriptRoot
$api = "https://api.github.com"
$headers = @{
  Authorization = "Bearer $GitHubToken"
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent" = "xueqiu-deploy"
}

Write-Host "==> Authenticating with GitHub..."
$me = Invoke-RestMethod -Uri "$api/user" -Headers $headers
$owner = $me.login
Write-Host "    Authenticated as: $owner"

Write-Host "==> Creating repository $RepoName ($Visibility)..."
$body = @{ name = $RepoName; private = ($Visibility -eq "private"); auto_init = $false } | ConvertTo-Json
try {
  Invoke-RestMethod -Uri "$api/user/repos" -Method Post -Headers $headers -Body $body -ContentType "application/json" | Out-Null
  Write-Host "    Repository created."
} catch {
  if ($_.Exception.Response -and $_.Exception.Response.StatusCode -eq 422) {
    Write-Host "    Repository already exists (continuing)."
  } else { throw }
}

Write-Host "==> Pushing code to GitHub..."
Set-Location $base
git config user.email "monitor@local" 2>$null
git config user.name "xueqiu-monitor" 2>$null
if (-not (Test-Path .git)) { git init -q }
$remoteUrl = "https://$owner`:$GitHubToken@github.com/$owner/$RepoName.git"
git remote remove origin 2>$null
git remote add origin $remoteUrl
git branch -M main
git push -q -f origin main
Write-Host "    Code pushed to main."

Write-Host "==> Building secrets payload (reads cookies from ../xueqiu_sub/cookies.json)..."
$cookiesPath = Join-Path $base ".." "xueqiu_sub" "cookies.json"
$cookies = (Get-Content -Raw $cookiesPath).Trim()
$secrets = @{
  XUEQIU_COOKIES = $cookies
  QQ_USER        = "3196846119@qq.com"
  QQ_PASS        = $QQPass
  EMAIL_TO       = "3196846119@qq.com"
}
$secretsFile = Join-Path $base ".secrets_payload.json"
$secrets | ConvertTo-Json -Compress | Set-Content -NoNewline $secretsFile

Write-Host "==> Encrypting & setting GitHub secrets..."
$node = "C:/Users/zhijian/.workbuddy/binaries/node/versions/22.22.2/node.exe"
$setSecrets = Join-Path $base "set_secrets.mjs"
& $node $setSecrets $GitHubToken $owner $RepoName $secretsFile
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Automatic secret setting failed. Fallback: copy values from SECRETS.txt into GitHub Settings > Secrets."
  throw "Secret setting failed."
}
Remove-Item $secretsFile -Force

Write-Host "==> Enabling workflow..."
try {
  Invoke-RestMethod -Uri "$api/repos/$owner/$RepoName/actions/workflows/xueqiu-monitor.yml/enable" -Method Put -Headers $headers | Out-Null
  Write-Host "    Workflow enabled."
} catch {
  Write-Host "    (workflow will auto-enable on first push; ignoring: $($_.Exception.Message))"
}

Write-Host ""
Write-Host "============================================================"
Write-Host "DONE. Monitoring now runs every 3 min on GitHub servers."
Write-Host "=> PC shut down / asleep => still crawls & emails you."
Write-Host ""
Write-Host "FINAL STEP — stop the PC task to avoid DOUBLE emails:"
Write-Host "    schtasks /Delete /TN XueqiuMonitor_3min /F"
Write-Host "============================================================"
