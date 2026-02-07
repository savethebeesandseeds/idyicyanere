# Idyicyanere
by: waajacu.com

Idyicyanere is a VS Code extension that helps you edit a codebase with AI, safely and with good context.

- Pick files/folders you want the AI to consider (keyboard-friendly).
- Dump context from those paths into a clean snapshot for prompting.
- Plan changes from a natural language request into a concrete set of edits.
- Review diffs and apply changes with clear state and logs.

The focus is simple: better context in, clearer edits out, and you stay in control.


# Native addon quick checks
## Clean + rebuild the addon
rm -rf native/idydb-addon/build
npm run build:native

## Smoke-test the compiled .node
node -e "const a=require('./native/idydb-addon/build/Release/idydb.node'); console.log('addon keys:', Object.keys(a));"

## TypeScript compile
npm run compile

## Build + package VSIX per OS (and install it)



# Linux
### Install system deps (OpenSSL headers + build tools), then build + package:
sudo apt-get update
sudo apt-get install -y build-essential python3 make g++ libssl-dev

npm ci
npm run vsix:local

## Install
In VS Code: press Ctrl+Shift+P → run “Extensions: Install from VSIX…” → pick dist-vsix/idyicyanere-linux-x64.vsix.

### Install the VSIX:
ls -lh dist-vsix/idyicyanere-linux-x64.vsix
code --install-extension dist-vsix/idyicyanere-linux-x64.vsix

#### or for VS Code Insiders:
code-insiders --install-extension dist-vsix/idyicyanere-linux-x64.vsix


# Windows (PowerShell)

### windows installs
winget install -e --id ShiningLight.OpenSSL
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Python.Python.3
winget install -e --id Git.Git

### set these to the actual OpenSSL path on your machine
$env:OPENSSL_DIR="C:\Program Files\OpenSSL-Win64"
$env:OPENSSL_INCLUDE_DIR="$env:OPENSSL_DIR\include"
$env:OPENSSL_LIB_DIR="$env:OPENSSL_DIR\lib"

### node installs
npm ci
npm run compile
npm run build:native
npm run vsix:package

### Install the VSIX:
In VS Code: press Ctrl+Shift+P → run “Extensions: Install from VSIX…” → pick dist-vsix/idyicyanere-linux-x64.vsix.
### or:
code --install-extension dist-vsix\idyicyanere-win32.vsix
### or:
code-insiders --install-extension dist-vsix\idyicyanere-win32.vsix
