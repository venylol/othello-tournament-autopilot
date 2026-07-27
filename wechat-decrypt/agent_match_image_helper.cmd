@echo off
setlocal

set "ROOT=%~dp0"
set "PY=%ROOT%.venv\Scripts\python.exe"
set "SCRIPT=%ROOT%agent_match_image_helper.py"

if not exist "%PY%" (
  echo Cannot find project Python:
  echo %PY%
  echo Run setup or install requirements into wechat-decrypt\.venv before using the match image helper.
  exit /b 1
)

if not exist "%SCRIPT%" (
  echo Cannot find match image helper script:
  echo %SCRIPT%
  exit /b 1
)

"%PY%" "%SCRIPT%" %*
exit /b %ERRORLEVEL%
