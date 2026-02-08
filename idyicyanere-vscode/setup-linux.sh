#!/bin/bash

# Salir si hay errores
set -e

echo "--- 1/4 Installing System Dependencies ---"
apt update
apt install -y build-essential python3 make g++ libssl-dev git

# Verificar si Node.js está instalado
if ! command -v node &> /dev/null; then
    echo "Node.js not found. Installing..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | -E bash -
    apt install -y nodejs
fi

echo "--- 2/4 Installing Project Dependencies ---"
# Usamos install para asegurar que esbuild y node-gyp estén listos
npm install

echo "--- 3/4 Building & Bundling ---"
# Limpieza inicial
npm run vsix:clean

# Generamos el bundle (un solo archivo JS)
npm run bundle

# Compilamos el addon nativo para Linux
npm run build:native

echo "--- 4/4 Packaging VSIX ---"
# Empaquetamos sin incluir node_modules (porque ya están en el bundle)
npm run vsix:package

echo ""
echo "BUILD COMPLETE! Your optimized VSIX is in dist-vsix/"