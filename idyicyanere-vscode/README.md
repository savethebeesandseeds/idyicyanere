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
npm run vsix:linux
ls -lh dist-vsix/idyicyanere-linux.vsix

### Install the VSIX:

code --install-extension dist-vsix/idyicyanere-linux.vsix
#### or for VS Code Insiders:
code-insiders --install-extension dist-vsix/idyicyanere-linux.vsix




# macOS
Install OpenSSL via Homebrew and expose include/lib paths for node-gyp:
brew install openssl@3
export OPENSSL_INCLUDE_DIR="$(brew --prefix openssl@3)/include"
export OPENSSL_LIB_DIR="$(brew --prefix openssl@3)/lib"

npm ci
npm run vsix:darwin
ls -lh dist-vsix/idyicyanere-darwin.vsix


### Install the VSIX:

code --install-extension dist-vsix/idyicyanere-darwin.vsix
### or:
code-insiders --install-extension dist-vsix/idyicyanere-darwin.vsix



# Windows (PowerShell)

### You need OpenSSL headers + .lib files. Set env vars so node-gyp can find them:
$env:OPENSSL_INCLUDE_DIR="C:\path\to\openssl\include"
$env:OPENSSL_LIB_DIR="C:\path\to\openssl\lib"

npm ci
npm run vsix:win32
dir dist-vsix

### Install the VSIX:

code --install-extension dist-vsix\idyicyanere-win32.vsix
### or:
code-insiders --install-extension dist-vsix\idyicyanere-win32.vsix


### If you’re using vcpkg, these env vars typically look like:
$env:OPENSSL_INCLUDE_DIR="C:\path\to\vcpkg\installed\x64-windows\include"
$env:OPENSSL_LIB_DIR="C:\path\to\vcpkg\installed\x64-windows\lib"
