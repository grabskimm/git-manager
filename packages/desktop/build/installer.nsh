; Custom NSIS hooks injected by electron-builder via nsis.include.
;
; Adds the install directory to the current user's PATH on install so `gitm`
; (the gitm.cmd shim bundled alongside GitManager.exe) is accessible from any
; new terminal without a full log-out/log-in. Removes it on uninstall.
;
; Uses PowerShell — always present on Windows 10+ — rather than an NSIS plugin
; dependency (EnvVarUpdate.nsh is not part of the NSIS standard distribution).
; $INSTDIR is an NSIS variable expanded at build time; $$ escapes to a literal $
; in the generated script.

!macro customInstall
  ; Skip if $INSTDIR is already in the user PATH.
  nsExec::ExecToStack "powershell -NoProfile -NonInteractive -Command $\"$$p=[Environment]::GetEnvironmentVariable('PATH','User'); if ($$p -notlike '*$INSTDIR*') { [Environment]::SetEnvironmentVariable('PATH', $$p + ';$INSTDIR', 'User') }$\""
  ; Broadcast the change so already-open CMD/PowerShell windows pick it up.
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro customUnInstall
  ; Remove every occurrence of $INSTDIR from the user PATH.
  nsExec::ExecToStack "powershell -NoProfile -NonInteractive -Command $\"[Environment]::SetEnvironmentVariable('PATH', (([Environment]::GetEnvironmentVariable('PATH','User') -split ';') | Where-Object { $$_ -and $$_ -ne '$INSTDIR' }) -join ';', 'User')$\""
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend
