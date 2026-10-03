@echo off
REM Foxy CLI native host installer (Windows).
REM Copies the host to %LOCALAPPDATA%\foxy-cli and registers it in the registry.
setlocal
set "HOSTDIR=%LOCALAPPDATA%\foxy-cli"
set "SRCDIR=%~dp0"
if not exist "%HOSTDIR%" mkdir "%HOSTDIR%"
copy /y "%SRCDIR%foxy_host.py" "%HOSTDIR%\foxy_host.py" >nul

(
  echo @echo off
  echo python "%HOSTDIR%\foxy_host.py" %%*
) > "%HOSTDIR%\foxy_host.bat"

set "MANIFEST=%HOSTDIR%\foxy_cli.json"
(
  echo {
  echo   "name": "foxy_cli",
  echo   "description": "Foxy CLI native shell host",
  echo   "path": "%HOSTDIR:\=\\%\\foxy_host.bat",
  echo   "type": "stdio",
  echo   "allowed_extensions": ["foxy-cli@foxy.cli"]
  echo }
) > "%MANIFEST%"

reg add "HKCU\Software\Mozilla\NativeMessagingHosts\foxy_cli" /ve /t REG_SZ /d "%MANIFEST%" /f >nul

echo Foxy CLI native host installed.
echo   Host:       %HOSTDIR%\foxy_host.py
echo   Manifest:   %MANIFEST%
echo Restart Firefox, then reload the Foxy CLI extension.
endlocal