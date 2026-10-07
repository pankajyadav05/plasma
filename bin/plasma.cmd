@echo off
rem plasma - command-line companion for the Plasma desktop app (Windows).
rem   plasma open <connection-url | file.sqlite | folder>
rem   plasma import <file.csv> --into <connection-url> --table <name>
rem   plasma mcp   (stdio MCP bridge to the running Plasma)
setlocal
set "APP=%PLASMA_APP%"
if "%APP%"=="" set "APP=%~dp0..\..\Plasma.exe"
if not exist "%APP%" (
  echo plasma: cannot find Plasma.exe. Set PLASMA_APP=C:\path\to\Plasma.exe 1>&2
  exit /b 1
)
if /i "%~1"=="mcp" (
  "%APP%" --plasma-mcp-bridge
  exit /b %ERRORLEVEL%
)
if /i "%~1"=="open" (
  if "%~2"=="" goto usage
  set "TARGET=%~2"
  echo %~2| findstr /c:"://" >nul || set "TARGET=%~f2"
  start "" "%APP%" "--plasma-open=%TARGET%"
  exit /b 0
)
if /i "%~1"=="import" (
  if "%~2"=="" goto usage
  set "FILE=%~f2"
  set "INTO="
  set "TABLE="
  shift
  shift
  :opts
  if "%~1"=="" goto run
  if /i "%~1"=="--into" set "INTO=%~2"
  if /i "%~1"=="--table" set "TABLE=%~2"
  shift
  shift
  goto opts
  :run
  if "%INTO%"=="" goto usage
  if "%TABLE%"=="" goto usage
  start "" "%APP%" "--plasma-import=%FILE%" "--plasma-into=%INTO%" "--plasma-table=%TABLE%"
  exit /b 0
)
:usage
echo Usage: 1>&2
echo   plasma open ^<connection-url ^| file.sqlite ^| folder^> 1>&2
echo   plasma import ^<file^> --into ^<connection-url^> --table ^<name^> 1>&2
echo   plasma mcp 1>&2
exit /b 2
