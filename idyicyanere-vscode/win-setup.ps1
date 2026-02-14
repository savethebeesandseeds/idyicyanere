<#SYNOPSIS
    SETUP: Setup, Bundle and Build script for idyicyanere (Windows)
    Bundles with esbuild, builds native addon, packages VSIX.
#>

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-Admin {
    $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this script in an elevated PowerShell (Right click → Run as administrator)."
    }
}

function Refresh-Path {
    $machine = [System.Environment]::GetEnvironmentVariable("Path","Machine")
    $user    = [System.Environment]::GetEnvironmentVariable("Path","User")
    $env:Path = "$machine;$user"
}

function Download-File([string]$Url, [string]$OutFile) {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
    Invoke-WebRequest -Uri $Url -OutFile $OutFile
}

function Run-OrThrow {
    param(
        [Parameter(Mandatory=$true)]
        [string] $Cmd,

        [Parameter(ValueFromRemainingArguments=$true)]
        [string[]] $CmdArgs
    )

    & $Cmd @CmdArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed ($LASTEXITCODE): $Cmd $($CmdArgs -join ' ')"
    }
}

function Find-LatestSdkBinX64 {
    $sdkBinRoot = "C:\Program Files (x86)\Windows Kits\10\bin"
    if (-not (Test-Path $sdkBinRoot)) { return $null }

    $verDirs =
        Get-ChildItem $sdkBinRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^10\.0\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending

    foreach ($d in $verDirs) {
        $x64 = Join-Path $d.FullName "x64"
        if (Test-Path (Join-Path $x64 "rc.exe")) {
            return $x64
        }
    }
    return $null
}

function Ensure-VS-Env {
    # MSVC bin (cl/link)
    $msvcRoot = "C:\BuildTools\VC\Tools\MSVC"
    if (-not (Test-Path $msvcRoot)) { throw "MSVC directory not found at $msvcRoot" }

    $msvcVerDir = Get-ChildItem $msvcRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $msvcVerDir) { throw "No MSVC versions found under $msvcRoot" }

    $msvcBin = Join-Path $msvcVerDir.FullName "bin\Hostx64\x64"
    if (-not (Test-Path (Join-Path $msvcBin "cl.exe"))) {
        throw "cl.exe not found under $msvcBin (Build Tools may be incomplete)."
    }

    # Windows SDK bin (rc/mt)
    $sdkX64 = Find-LatestSdkBinX64
    if (-not $sdkX64) {
        throw "Windows SDK rc.exe not found. Install Windows 10 SDK (e.g. 10.0.19041) via VS Build Tools."
    }
    if (-not (Test-Path (Join-Path $sdkX64 "mt.exe"))) {
        throw "mt.exe not found under $sdkX64 (Windows SDK components missing)."
    }

    # MSBuild (helps node-gyp)
    $msbuild = "C:\BuildTools\MSBuild\Current\Bin"

    $prepend = @($msvcBin, $sdkX64)
    if (Test-Path $msbuild) { $prepend += $msbuild }

    $env:Path = ($prepend -join ";") + ";" + $env:Path
}

Assert-Admin
Refresh-Path

# Run from script directory
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

# --- 1/5 Installing Core Tools ---
Write-Host "--- 1/5 Installing Core Tools ---" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Download-File "https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi" "node.msi"
    Start-Process "msiexec.exe" -Wait -ArgumentList @("/i","node.msi","/qn","/norestart")
    Remove-Item "node.msi" -Force
    Refresh-Path
}

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Download-File "https://www.python.org/ftp/python/3.12.2/python-3.12.2-amd64.exe" "py.exe"
    Start-Process ".\py.exe" -Wait -ArgumentList @("/quiet","InstallAllUsers=1","PrependPath=1","Include_pip=1")
    Remove-Item "py.exe" -Force
    Refresh-Path
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Download-File "https://github.com/git-for-windows/git/releases/download/v2.44.0.windows.1/Git-2.44.0-64-bit.exe" "git.exe"
    Start-Process ".\git.exe" -Wait -ArgumentList @("/VERYSILENT","/NORESTART")
    Remove-Item "git.exe" -Force
    Refresh-Path

    $gitCmd = Join-Path $env:ProgramFiles "Git\cmd"
    if ((Test-Path $gitCmd) -and ($env:Path -notlike "*$gitCmd*")) {
        $env:Path = "$gitCmd;$env:Path"
    }
}

foreach ($c in @("node","npm","python","git")) {
    if (-not (Get-Command $c -ErrorAction SilentlyContinue)) {
        throw "Missing required command after install: $c"
    }
}

# --- 2/5 VS Build Tools 2022 ---
Write-Host "--- 2/5 Installing VS Build Tools 2022 ---" -ForegroundColor Cyan

$needBuildTools = -not (Test-Path "C:\BuildTools\VC\Tools\MSVC")
$needSdk = -not (Test-Path "C:\Program Files (x86)\Windows Kits\10\bin")

if ($needBuildTools -or $needSdk) {
    Download-File "https://aka.ms/vs/17/release/vs_buildtools.exe" "vs_buildtools.exe"

    Start-Process ".\vs_buildtools.exe" -Wait -ArgumentList @(
        "--quiet","--wait","--norestart","--nocache",
        "--installPath","C:\BuildTools",
        "--add","Microsoft.VisualStudio.Workload.VCTools",
        "--add","Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "--add","Microsoft.VisualStudio.Component.Windows10SDK.19041",
        "--add","Microsoft.VisualStudio.Component.VC.CMake.Project",
        "--add","Microsoft.VisualStudio.Component.Windows10SDK.19041.Desktop"
    )

    Remove-Item "vs_buildtools.exe" -Force
    Refresh-Path
}

# IMPORTANT: ensure PATH includes MSVC + SDK bins for THIS SESSION
Ensure-VS-Env

# --- 3/5 OpenSSL Setup ---
Write-Host "--- 3/5 Setting up OpenSSL via vcpkg ---" -ForegroundColor Cyan

if (-not (Test-Path "C:\vcpkg\vcpkg.exe")) {
    if (-not (Test-Path "C:\vcpkg")) {
        Run-OrThrow "git" "clone" "https://github.com/microsoft/vcpkg" "C:\vcpkg"
    }
    Run-OrThrow "C:\vcpkg\bootstrap-vcpkg.bat"
}

Run-OrThrow "C:\vcpkg\vcpkg.exe" "install" "openssl:x64-windows"
Run-OrThrow "C:\vcpkg\vcpkg.exe" "integrate" "install"

# --- 4/5 Fixing Environment (Toolchain & PATH) ---
Write-Host "--- 4/5 Fixing Environment (Toolchain & PATH) ---" -ForegroundColor Cyan

$env:OPENSSL_INCLUDE_DIR = "C:\vcpkg\installed\x64-windows\include"
$env:OPENSSL_LIB_DIR     = "C:\vcpkg\installed\x64-windows\lib"
$env:GYP_MSVS_VERSION    = "2022"

# Workaround: node-gyp sometimes lags behind newest VS versions
Run-OrThrow "npm" "install" "-g" "node-gyp"
$env:npm_config_node_gyp = (Get-Command node-gyp).Source

Set-Alias -Name pwsh -Value powershell -ErrorAction SilentlyContinue
if (-not (Test-Path "$env:APPDATA\npm")) { New-Item -ItemType Directory -Force -Path "$env:APPDATA\npm" | Out-Null }

# --- 5/5 BUILD ---
Write-Host "--- 5/5 BUILD: Bundling & Compiling ---" -ForegroundColor Cyan

Run-OrThrow "npm" "run" "vsix:win"

Write-Host "`nBUILD COMPLETE! Your optimized VSIX is in dist-vsix/" -ForegroundColor Green
