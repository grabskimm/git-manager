@echo off
rem gitm CLI shim — delegates to the engine bundled inside the desktop app.
rem %~dp0 expands to this file's directory (the install root), with trailing \.
rem The Electron binary (GitManager.exe) acts as Node when ELECTRON_RUN_AS_NODE=1.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0GitManager.exe" "%~dp0resources\app.asar.unpacked\node_modules\@git-manager\engine\dist\cli.js" %*
rem Preserve the engine's exit code: %errorlevel% is expanded before endlocal
rem restores the outer environment, so callers and CI see the real exit code.
endlocal & exit /b %errorlevel%
