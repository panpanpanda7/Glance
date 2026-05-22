param(
    [Parameter(Mandatory=$true)]
    [string]$DestDir
)

$ErrorActionPreference = 'Stop'

Write-Host "  GitHub API から llama.cpp 最新リリース情報を取得中..."
try {
    $rel = (Invoke-WebRequest -Uri "https://api.github.com/repos/ggerganov/llama.cpp/releases/latest" -UseBasicParsing).Content | ConvertFrom-Json
} catch {
    Write-Host "[ERROR] GitHub API への接続に失敗しました: $_"
    exit 1
}
Write-Host "  リリース: $($rel.tag_name)"

$asset = $rel.assets | Where-Object {
    $_.name -match "bin-win.*x64.*\.zip$" -and $_.name -notmatch "cuda|opencl|hipblas"
} | Select-Object -First 1

if (-not $asset) {
    Write-Host "[ERROR] Windows x64 バイナリが見つかりませんでした。"
    Write-Host "利用可能な assets:"
    $rel.assets | ForEach-Object { Write-Host "  - $($_.name)" }
    exit 1
}

Write-Host "  ダウンロード: $($asset.name)"
Write-Host "  （数百MB あります。しばらくお待ちください...）"

$zipPath = Join-Path $env:TEMP "llama-cpp-bin.zip"
$extractPath = Join-Path $env:TEMP "llama-cpp-extracted"

try {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -UseBasicParsing
} catch {
    Write-Host "[ERROR] ダウンロードに失敗しました: $_"
    exit 1
}
Write-Host "  ダウンロード完了。展開中..."

if (Test-Path $extractPath) { Remove-Item $extractPath -Recurse -Force }
Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force

$exe = Get-ChildItem -Path $extractPath -Recurse -Filter "llama-server.exe" | Select-Object -First 1
if (-not $exe) {
    Write-Host "[ERROR] ZIP の中に llama-server.exe が見つかりませんでした。"
    exit 1
}

if (-not (Test-Path $DestDir)) { New-Item -ItemType Directory -Path $DestDir -Force | Out-Null }

Copy-Item -Path "$($exe.Directory.FullName)\*" -Destination $DestDir -Force
Write-Host "  [OK] llama-server.exe を配置しました: $DestDir"

Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
Remove-Item $extractPath -Recurse -Force -ErrorAction SilentlyContinue
