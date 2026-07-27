@echo off
setlocal

set "ROOT=%~dp0"
set "PY=%ROOT%.venv\Scripts\python.exe"
set "SCRIPT=%ROOT%agent_checkin_bridge.py"

if not exist "%PY%" (
  echo Cannot find project Python:
  echo %PY%
  echo Run setup or install requirements into wechat-decrypt\.venv before using the check-in bridge.
  exit /b 1
)

if not exist "%SCRIPT%" (
  echo Cannot find bridge script:
  echo %SCRIPT%
  exit /b 1
)

"%PY%" "%SCRIPT%" %*
exit /b %ERRORLEVEL%
