; Glance NSIS Installer Custom Script
; インストール前にGlanceプロセスを強制終了

!macro customInit
  ; ログを開始
  DetailPrint "Glanceプロセスを確認しています..."
  
  ; Glance.exeを強制終了
  nsExec::ExecToLog 'taskkill /F /IM Glance.exe /T'
  Pop $0
  
  ; glance-backend.exeを強制終了
  nsExec::ExecToLog 'taskkill /F /IM glance-backend.exe /T'
  Pop $0
  
  ; Pythonプロセスも念のため終了
  nsExec::ExecToLog 'taskkill /F /IM python.exe /T'
  Pop $0
  
  ; 少し待機（ファイルのロック解放を待つ）
  Sleep 2000
  
  DetailPrint "既存プロセスの終了が完了しました。インストールを開始します..."
!macroend

!macro customUnInit
  ; アンインストール後の処理（必要に応じて追加）
!macroend
