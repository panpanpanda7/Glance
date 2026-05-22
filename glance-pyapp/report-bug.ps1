param(
    [Parameter(Mandatory=$true)]
    [string]$RepoDir
)

$ErrorActionPreference = 'Stop'

$REPO_OWNER = "panpanpanda7"
$REPO_NAME  = "Glance"

# ============================================================
# Token 読み込み
# ============================================================
$tokenFile = Join-Path $RepoDir "reporter-token.txt"
if (-not (Test-Path $tokenFile)) {
    Write-Host "[ERROR] reporter-token.txt が見つかりません。"
    Write-Host "        開発者から受け取った reporter-token.txt を"
    Write-Host "        glance-pyapp フォルダに置いてください。"
    exit 1
}
$token = (Get-Content $tokenFile -Raw).Trim()
if (-not $token -or $token -eq "ここにトークンを貼り付ける") {
    Write-Host "[ERROR] reporter-token.txt にトークンが設定されていません。"
    exit 1
}

# ============================================================
# ログ収集
# ============================================================
Write-Host "Collecting logs..."

# update-and-run.log
$logFile = Join-Path $RepoDir "update-and-run.log"
$logContent = if (Test-Path $logFile) {
    $raw = Get-Content $logFile -Raw -Encoding UTF8
    if ($raw.Length -gt 8000) { "...(省略)...`n" + $raw.Substring($raw.Length - 8000) } else { $raw }
} else {
    "(ログファイルなし)"
}

# システム情報
$osInfo    = (Get-CimInstance Win32_OperatingSystem).Caption
$ramGB     = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
$freeRamGB = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 1)
$pythonVer = & python --version 2>&1
$nodeVer   = & node --version 2>&1
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

# llama-server.exe の存在確認
$llamaPath = Join-Path $RepoDir "python-backend\llama-cpp-bin\llama-server.exe"
$llamaStatus = if (Test-Path $llamaPath) { "found" } else { "NOT FOUND" }

# モデルファイルの存在確認
$modelDir  = Join-Path $RepoDir "python-backend\models\gguf"
$modelFiles = if (Test-Path $modelDir) {
    (Get-ChildItem $modelDir -File | Select-Object Name, @{N="SizeMB";E={[math]::Round($_.Length/1MB,1)}} | ForEach-Object { "$($_.Name) ($($_.SizeMB) MB)" }) -join "`n"
} else { "(フォルダなし)" }

# ============================================================
# Issue 本文作成
# ============================================================
$body = @"
## Environment
- Date: $timestamp
- OS: $osInfo
- RAM: $ramGB GB total / $freeRamGB GB free
- Python: $pythonVer
- Node.js: $nodeVer
- llama-server.exe: $llamaStatus

## Model Files
$modelFiles

## Log (update-and-run.log)
``````
$logContent
``````
"@

$title = "Bug Report - $timestamp"

# ============================================================
# GitHub Issue 投稿
# ============================================================
Write-Host "Posting GitHub Issue..."

$headers = @{
    "Authorization" = "Bearer $token"
    "Accept"        = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
}

$payload = @{
    title  = $title
    body   = $body
    labels = @("bug", "tester-report")
} | ConvertTo-Json -Depth 3

try {
    $response = Invoke-WebRequest `
        -Uri "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/issues" `
        -Method Post `
        -Headers $headers `
        -Body $payload `
        -ContentType "application/json; charset=utf-8" `
        -UseBasicParsing
    $issue = $response.Content | ConvertFrom-Json
    Write-Host ""
    Write-Host "[OK] Issue を投稿しました:"
    Write-Host "     $($issue.html_url)"
} catch {
    Write-Host "[ERROR] Issue の投稿に失敗しました: $_"
    exit 1
}
