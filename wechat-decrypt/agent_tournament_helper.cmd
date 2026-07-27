@echo off
setlocal

set "ROOT=%~dp0"
set "PY=%ROOT%.venv\Scripts\python.exe"
set "SCRIPT=%ROOT%agent_tournament_helper.py"

if not exist "%PY%" (
  echo Cannot find project Python:
  echo %PY%
  echo Run setup or install requirements into wechat-decrypt\.venv before using the tournament helper.
  exit /b 1
)

if not exist "%SCRIPT%" (
  echo Cannot find tournament helper script:
  echo %SCRIPT%
  exit /b 1
)

"%PY%" "%SCRIPT%" %*
exit /b %ERRORLEVEL%
