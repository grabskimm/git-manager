; Custom NSIS hooks injected by electron-builder via nsis.include.
;
; Adds the install directory to the current user's PATH on install so `gitm`
; (the gitm.cmd shim bundled alongside GitManager.exe) is accessible from any
; new terminal without a log-out/log-in. Removes it on uninstall.
;
; Uses PowerShell (always present on Windows 10+) rather than an NSIS plugin
; dependency (EnvVarUpdate.nsh is not in the NSIS standard distribution).
; $INSTDIR is an NSIS runtime variable — it is expanded when the installer
; actually runs on the user's machine, not at build time. $$ in an NSIS string
; escapes to a literal $, required for PowerShell variables ($$p, $$norm, $$_).

!include "WinMessages.nsh"

!macro customInstall
  ; Exact, case-insensitive, backslash-normalized PATH match: avoids treating
  ; "C:\Programs\GitManager" as already present due to "C:\Programs\GitManager2",
  ; and handles both stored-with and stored-without trailing backslash.
  ; .TrimStart(';') keeps PATH valid when it is empty or null on a fresh system.
  ; Pop the two values nsExec::ExecToStack pushes (exit code + stdout).
  nsExec::ExecToStack "powershell -NoProfile -NonInteractive -Command $\"$$norm='$INSTDIR'.TrimEnd('\'); if (-not (([Environment]::GetEnvironmentVariable('PATH','User') -split ';') | Where-Object { $$_.TrimEnd('\') -ieq $$norm })) { $$p=[Environment]::GetEnvironmentVariable('PATH','User'); [Environment]::SetEnvironmentVariable('PATH', ($$p + ';' + $$norm).TrimStart(';'), 'User') }$\""
  Pop $0  ; nsExec exit code (ignored — PATH change is best-effort)
  Pop $1  ; nsExec stdout  (unused)
  ; Broadcast so already-open CMD/PowerShell windows pick up the new PATH.
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro customUnInstall
  ; Remove every PATH entry that exactly matches $INSTDIR (with or without a
  ; trailing backslash) so the entry is cleaned up even if it was stored
  ; slightly differently from how the installer wrote it.
  nsExec::ExecToStack "powershell -NoProfile -NonInteractive -Command $\"$$norm='$INSTDIR'.TrimEnd('\'); [Environment]::SetEnvironmentVariable('PATH', (([Environment]::GetEnvironmentVariable('PATH','User') -split ';') | Where-Object { $$_ -and $$_.TrimEnd('\') -ine $$norm }) -join ';', 'User')$\""
  Pop $0
  Pop $1
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend
