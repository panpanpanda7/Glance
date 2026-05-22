param(
    [Parameter(Mandatory=$true)]
    [string]$DestDir
)

$ErrorActionPreference = 'Stop'

Write-Host "  Fetching latest llama.cpp release from GitHub API..."
try {
    $rel = (Invoke-WebRequest -Uri "https://api.github.com/repos/ggerganov/llama.cpp/releases/latest" -UseBasicParsing).Content | ConvertFrom-Json
} catch {
    Write-Host "[ERROR] Failed to connect to GitHub API: $_"
    exit 1
}
Write-Host "  Release: $($rel.tag_name)"

$asset = $rel.assets | Where-Object {
    $_.name -match "bin-win.*x64.*\.zip$" -and $_.name -notmatch "cuda|opencl|hipblas"
} | Select-Object -First 1

if (-not $asset) {
    Write-Host "[ERROR] Windows x64 binary not found."
    Write-Host "Available assets:"
    $rel.assets | ForEach-Object { Write-Host "  - $($_.name)" }
    exit 1
}

Write-Host "  Downloading: $($asset.name)"
Write-Host "  (This may take several minutes...)"

$zipPath = Join-Path $env:TEMP "llama-cpp-bin.zip"
$extractPath = Join-Path $env:TEMP "llama-cpp-extracted"

try {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -UseBasicParsing
} catch {
    Write-Host "[ERROR] Download failed: $_"
    exit 1
}
Write-Host "  Download complete. Extracting..."

if (Test-Path $extractPath) { Remove-Item $extractPath -Recurse -Force }
Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force

$exe = Get-ChildItem -Path $extractPath -Recurse -Filter "llama-server.exe" | Select-Object -First 1
if (-not $exe) {
    Write-Host "[ERROR] llama-server.exe not found in ZIP."
    exit 1
}

if (-not (Test-Path $DestDir)) { New-Item -ItemType Directory -Path $DestDir -Force | Out-Null }

Copy-Item -Path "$($exe.Directory.FullName)\*" -Destination $DestDir -Force
Write-Host "  [OK] llama-server.exe placed at: $DestDir"

Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
Remove-Item $extractPath -Recurse -Force -ErrorAction SilentlyContinue
