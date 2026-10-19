@echo off
setlocal EnableExtensions
title LinkGrab - Windows build

rem Move to the project root (the parent of this scripts folder)
cd /d "%~dp0.."
echo.
echo === LinkGrab Windows build ===
echo Project folder: %CD%
echo.

rem ---- 1. Node 20+ and npm -------------------------------------------------
where node >nul 2>nul
if errorlevel 1 goto :no_node
where npm >nul 2>nul
if errorlevel 1 goto :no_node

set "NODE_MAJOR="
for /f "tokens=1 delims=." %%a in ('node -v') do set "NODE_MAJOR=%%a"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
for /f "delims=" %%v in ('node -v') do set "NODE_FULL=%%v"
for /f "delims=" %%v in ('call npm -v') do set "NPM_FULL=%%v"
echo Node %NODE_FULL%, npm %NPM_FULL%

if %NODE_MAJOR% LSS 20 goto :old_node

rem ---- 2. Install dependencies --------------------------------------------
echo.
echo [1/2] Installing dependencies (npm install) - first run can take a few minutes...
call npm install
if errorlevel 1 goto :fail

rem ---- 3. Build installer + portable --------------------------------------
echo.
echo [2/2] Building Windows installer and portable exe (npm run dist)...
call npm run dist
if errorlevel 1 goto :fail

rem ---- 4. Report -----------------------------------------------------------
set "VER="
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "VER=%%v"

echo.
echo ==================================================================
echo  BUILD SUCCEEDED
echo ==================================================================
echo  Installer: %CD%\dist\LinkGrab-Setup-%VER%.exe
echo  Portable : %CD%\dist\LinkGrab-Portable-%VER%.exe
echo.
echo  The exe files are unsigned. If Windows SmartScreen warns you,
echo  click "More info" and then "Run anyway".
echo ==================================================================
if exist "dist" start "" explorer "%CD%\dist"
goto :done

:no_node
echo ERROR: Node.js or npm was not found on PATH.
echo Install the Node.js 20 or newer LTS from https://nodejs.org and run this script again.
goto :done

:old_node
echo ERROR: Node.js 20 or newer is required, but you have %NODE_FULL%.
echo Install the current LTS from https://nodejs.org and run this script again.
goto :done

:fail
echo.
echo ERROR: The build failed. Scroll up to read the error messages.
echo Tips: check your internet connection (electron-builder downloads Electron
echo and NSIS on first run), and temporarily pause antivirus if it blocks files.

:done
echo.
pause
endlocal
