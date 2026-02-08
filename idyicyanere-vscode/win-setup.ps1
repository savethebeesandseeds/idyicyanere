<#
.SYNOPSIS
    SETUP: Setup, Bundle and Build script for idyicyanere (Windows)
    Reduces file count from 2000+ to <20 files using esbuild.
#>

$ErrorActionPreference = "Stop"

# --- 1/5 Installing Core Tools ---
Write-Host "--- 1/5 Installing Core Tools ---" -ForegroundColor Cyan
if (!(Get-Command node -ErrorAction SilentlyContinue)) {
    iwr https://nodejs.org/dist/v20.17.0/node-v20.17.0-x64.msi -OutFile node.msi
    Start-Process msiexec -Wait -ArgumentList '/i node.msi /qn'
    Remove-Item node.msi
}
if (!(Get-Command python -ErrorAction SilentlyContinue)) {
    iwr https://www.python.org/ftp/python/3.12.2/python-3.12.2-amd64.exe -OutFile py.exe
    Start-Process .\py.exe -Wait -ArgumentList '/quiet InstallAllUsers=1 PrependPath=1'
    Remove-Item py.exe
}
if (!(Get-Command git -ErrorAction SilentlyContinue)) {
    iwr https://github.com/git-for-windows/git/releases/download/v2.44.0.windows.1/Git-2.44.0-64-bit.exe -OutFile git.exe
    Start-Process .\git.exe -Wait -ArgumentList '/VERYSILENT /NORESTART'
    Remove-Item git.exe
}

# REFRESH PATH for the current session
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# --- 2/5 VS Build Tools 2022 ---
Write-Host "--- 2/5 Installing VS Build Tools 2022 ---" -ForegroundColor Cyan
if (!(Test-Path "C:\BuildTools")) {
    iwr https://aka.ms/vs/17/release/vs_buildtools.exe -OutFile vs_buildtools.exe
    Start-Process .\vs_buildtools.exe -Wait -ArgumentList '--quiet --wait --norestart --nocache --installPath C:\BuildTools --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows11SDK.22000'
    Remove-Item vs_buildtools.exe
}

# --- 3/5 OpenSSL Setup ---
Write-Host "--- 3/5 Setting up OpenSSL via vcpkg ---" -ForegroundColor Cyan
if (!(Test-Path "C:\vcpkg")) {
    git clone https://github.com/microsoft/vcpkg C:\vcpkg
    & C:\vcpkg\bootstrap-vcpkg.bat
}
& C:\vcpkg\vcpkg.exe install openssl:x64-windows
& C:\vcpkg\vcpkg.exe integrate install

# --- 4/5 Fixing Environment (The "CVT1107" Vaccine) ---
Write-Host "--- 4/5 Fixing Environment (Linker & PATH) ---" -ForegroundColor Cyan
$oldLinker = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\cvtres.exe"
if (Test-Path $oldLinker) { 
    Rename-Item $oldLinker "cvtres.exe.old" -ErrorAction SilentlyContinue 
}

$msvcPath = "C:\BuildTools\VC\Tools\MSVC"
$msvcVer = (Get-ChildItem -Path $msvcPath | Sort-Object Name -Descending)[0].Name
$msvcBin = "$msvcPath\$msvcVer\bin\Hostx64\x64"

$env:PATH = "$msvcBin;C:\BuildTools\Common7\IDE;$env:PATH"
$env:OPENSSL_INCLUDE_DIR='C:\vcpkg\installed\x64-windows\include'
$env:OPENSSL_LIB_DIR='C:\vcpkg\installed\x64-windows\lib'
$env:GYP_MSVS_VERSION="2022"

# Docker Hacks
Set-Alias -Name pwsh -Value powershell -ErrorAction SilentlyContinue
if (!(Test-Path "$env:APPDATA\npm")) { New-Item -ItemType Directory -Force -Path "$env:APPDATA\npm" }

# --- 5/5 BUILD (Bundling & Compiling) ---
Write-Host "--- 5/5 BUILD: Bundling with esbuild ---" -ForegroundColor Cyan
# Re-install dependencies to ensure esbuild is present
npm install
npm run vsix:win

Write-Host "`nBUILD COMPLETE! Your optimized VSIX is in dist-vsix/" -ForegroundColor Green