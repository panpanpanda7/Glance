# ============================================================
#  Glance 関連プロセスの一括停止（クリーン起動用）
#  update-and-run.bat から起動前に呼ばれる。
#  前回の異常終了で残った llama-server / バックエンド / Electron が
#  ポート占有・RAM圧迫・別モデル誤掴みを引き起こすのを防ぐ。
# ============================================================
$ErrorActionPreference = 'SilentlyContinue'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path  # glance-pyapp
$targets = @()

# 1) モデルサーバーと配布版バックエンド（名前で特定できるもの）
foreach ($name in 'llama-server', 'glance-backend', 'Glance') {
    $targets += Get-Process -Name $name -ErrorAction SilentlyContinue
}

# 2) このリポジトリから起動された electron / python / node（開発モード）
$known = @('electron.exe', 'python.exe', 'node.exe')
Get-CimInstance Win32_Process |
    Where-Object { $known -contains $_.Name } |
    Where-Object {
        ($_.ExecutablePath -like "$repoRoot*") -or
        ($_.CommandLine -like "*$repoRoot*")
    } |
    ForEach-Object { $targets += Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }

$targets = $targets | Where-Object { $_ -and $_.Id -ne $PID } | Sort-Object Id -Unique

if ($targets) {
    foreach ($t in $targets) {
        Write-Host ("  停止: {0} (PID {1})" -f $t.ProcessName, $t.Id)
        Stop-Process -Id $t.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 800   # ポート解放を待つ
    Write-Host "  [OK] 既存のGlanceプロセスを停止しました。"
} else {
    Write-Host "  [OK] 既存のGlanceプロセスはありません。"
}

# 3) Glance が使うポートがまだ塞がっていたら警告（無関係なソフトは殺さない）
foreach ($port in 8080, 5001) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        $owner = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        if ($owner) {
            Write-Host ("  [WARNING] ポート {0} を {1} (PID {2}) が使用中です。Glance が起動できない場合はこのプロセスを終了してください。" -f $port, $owner.ProcessName, $owner.Id)
        }
    }
}
exit 0
