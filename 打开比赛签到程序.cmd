@echo off
setlocal

set "ROOT=%~dp0"
set "APP_DIR=%ROOT%tournament_arrangement\recovered"
set "WECHAT_DIR=%ROOT%wechat-decrypt"
set "TOURNAMENT_HELPER=%WECHAT_DIR%\agent_tournament_helper.cmd"
set "FTD_EXPORT=%APP_DIR%\ftd-export.js"
set "FTD_CONSOLE=%APP_DIR%\ftd-download-console.js"
set "CHECKIN_BRIDGE=%WECHAT_DIR%\agent_checkin_bridge.cmd"
set "MATCH_IMAGE_HELPER=%WECHAT_DIR%\agent_match_image_helper.cmd"
set "EGA_ANALYSIS_HELPER=%WECHAT_DIR%\agent_egaroucid_analysis.cmd"
set "EGA_ENGINE=%ROOT%Egaroucid_for_Console_7_8_1_Windows_AVX512_AMD\Egaroucid_for_Console_7_8_1_AVX512_AMD.exe"
set "APP_URL=http://127.0.0.1:4174/"
set "HEALTH_URL=http://127.0.0.1:4174/api/health"

echo Tournament local workflow launcher
echo ==================================
echo.
echo This starts the always-on local dependency and checks the on-demand
echo helpers used by check-in, FTD pairing import, and score image review.
echo.

if not exist "%APP_DIR%\local-server.js" (
  echo [ERROR] local-server.js not found:
  echo %APP_DIR%\local-server.js
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node was not found in PATH.
  echo Install Node.js or add node to PATH.
  pause
  exit /b 1
)

echo [1/4] Checking local page server...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $localServers=@(Get-CimInstance Win32_Process -Filter 'name = ''node.exe''' | Where-Object { $_.CommandLine -like '*local-server.js*' }); $healthy=$false; try { $r=Invoke-RestMethod -Uri '%HEALTH_URL%' -TimeoutSec 1; if ($r.ok -eq $true -and $r.automationVersion -eq 'ftd-autopilot.6') { $healthy=$true } } catch { }; if (-not $healthy) { if ($localServers.Count) { Write-Host '[INFO] Restarting outdated local-server.js.'; foreach ($p in $localServers) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 800 }; Start-Process powershell -WindowStyle Minimized -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-Command','Set-Location -LiteralPath ''%APP_DIR%''; node local-server.js' }"

echo [2/4] Waiting for local API...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for ($i=0; $i -lt 20; $i++) { try { $r=Invoke-WebRequest -UseBasicParsing -Uri '%HEALTH_URL%' -TimeoutSec 1; if ($r.StatusCode -eq 200) { $ok=$true; break } } catch { Start-Sleep -Milliseconds 500 } }; if (-not $ok) { exit 1 }"
if errorlevel 1 (
  echo [ERROR] local API did not become ready.
  echo Try manually:
  echo cd /d "%APP_DIR%"
  echo node local-server.js
  pause
  exit /b 1
)

echo [3/4] Checking local workflow dependencies...
if exist "%TOURNAMENT_HELPER%" (
  echo [OK] agent_tournament_helper.cmd
) else (
  echo [WARN] agent_tournament_helper.cmd not found
)

if exist "%CHECKIN_BRIDGE%" (
  echo [OK] agent_checkin_bridge.cmd
) else (
  echo [WARN] agent_checkin_bridge.cmd not found
)

if exist "%MATCH_IMAGE_HELPER%" (
  echo [OK] agent_match_image_helper.cmd
) else (
  echo [WARN] agent_match_image_helper.cmd not found
)

if exist "%EGA_ANALYSIS_HELPER%" (
  echo [OK] agent_egaroucid_analysis.cmd
) else (
  echo [WARN] agent_egaroucid_analysis.cmd not found
)

if exist "%EGA_ENGINE%" (
  echo [OK] Egaroucid console 7.8.1 AVX512 AMD
) else (
  echo [WARN] Egaroucid console not found
)

if exist "%WECHAT_DIR%\.venv\Scripts\python.exe" (
  echo [OK] wechat-decrypt virtualenv Python
) else (
  echo [WARN] wechat-decrypt virtualenv Python not found
)

if exist "%FTD_EXPORT%" (
  echo [OK] FTD browser export script
) else (
  echo [WARN] ftd-export.js not found
)

if exist "%FTD_CONSOLE%" (
  echo [OK] FTD direct download console script
) else (
  echo [WARN] ftd-download-console.js not found
)

echo [4/4] Opening local page...
start "" "%APP_URL%"

echo.
echo Ready:
echo - Local page: %APP_URL%
echo - Local state API: %HEALTH_URL%
echo - Static file service for the FTD console export-code button
echo - Check-in and score helper wrappers are available if marked [OK] above
echo.
echo Tournament-day command entry:
echo cd /d "%WECHAT_DIR%"
echo .\agent_tournament_helper.cmd refresh-map
echo .\agent_tournament_helper.cmd score-scan --round N --start "YYYY-MM-DD HH:MM:SS" --end "YYYY-MM-DD HH:MM:SS"
echo .\agent_egaroucid_analysis.cmd watch
echo.
echo This launcher starts the local page dependency, but does NOT read WeChat
echo messages, does NOT run refresh-map, does NOT run score-scan, and does
echo NOT run Egaroucid analysis, and does NOT deploy Pages.
echo Run those steps only after the referee/user explicitly starts check-in
echo or score registration.
echo.
pause
endlocal
