#!/bin/bash
# Build dist/wfp-render.exe (Windows x64) from Linux via Bun cross-compile.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x node_modules/.bin/bun ]; then
  npm init -y >/dev/null 2>&1 || true
  npm i --no-audit --no-fund bun
fi

# single-file bundle: ziplite (UMD) + bridge + app (strip app shebang)
{
  cat ziplite.js
  echo ';globalThis.__ZIPLITE__ = (typeof module !== "undefined" && module.exports) || ZipLite;'
  echo ';module.exports = undefined;'
  tail -n +2 app.js
} > bundle.js

./node_modules/.bin/bun build --compile --target=bun-windows-x64 bundle.js --outfile ../../dist/wfp-render.exe
ls -la ../../dist/wfp-render.exe
