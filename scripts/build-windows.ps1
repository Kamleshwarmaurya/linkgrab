# LinkGrab - Windows build (PowerShell version of build-windows.bat)
# Run:  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
$ErrorActionPreference = 'Stop'

function Pause-End {
    Write-Host ''
    Read-Host 'Press Enter to close' | Out-Null
}

try {
    Set-Location (Join-Path $PSScriptRoot '..')
    Write-Host ''
    Write-Host '=== LinkGrab Windows build ==='
    Write-Host "Project folder: $(Get-Location)"
    Write-Host ''

    # 1. Node 20+ and npm
    if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'Node.js or npm was not found on PATH. Install the Node.js 20+ LTS from https://nodejs.org and run this script again.'
    }
    $nodeFull = (node -v).Trim()
    $npmFull = (npm -v).Trim()
    Write-Host "Node $nodeFull, npm $npmFull"
    $major = [int]($nodeFull.TrimStart('v').Split('.')[0])
    if ($major -lt 20) {
        throw "Node.js 20 or newer is required, but you have $nodeFull. Install the current LTS from https://nodejs.org"
    }

    # 2. Install dependencies
    Write-Host ''
    Write-Host '[1/2] Installing dependencies (npm install) - first run can take a few minutes...'
    npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }

    # 3. Build
    Write-Host ''
    Write-Host '[2/2] Building Windows installer and portable exe (npm run dist)...'
    npm run dist
    if ($LASTEXITCODE -ne 0) { throw 'npm run dist failed.' }

    # 4. Report
    $ver = (node -p "require('./package.json').version").Trim()
    $dist = Join-Path (Get-Location) 'dist'
    Write-Host ''
    Write-Host '=================================================================='
    Write-Host ' BUILD SUCCEEDED'
    Write-Host '=================================================================='
    Write-Host " Installer: $dist\LinkGrab-Setup-$ver.exe"
    Write-Host " Portable : $dist\LinkGrab-Portable-$ver.exe"
    Write-Host ''
    Write-Host ' The exe files are unsigned. If Windows SmartScreen warns you,'
    Write-Host ' click "More info" and then "Run anyway".'
    Write-Host '=================================================================='
    if (Test-Path $dist) { Start-Process explorer.exe $dist }
}
catch {
    Write-Host ''
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Scroll up to read the error messages. Check your internet connection and antivirus.'
}
Pause-End
