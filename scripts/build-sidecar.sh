#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON_BIN="$PROJECT_ROOT/python/.venv/bin/python"
TARGET_TRIPLE="aarch64-apple-darwin"
BUILD_ROOT="$PROJECT_ROOT/build/sidecar"

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "python/.venv がありません。python3 -m venv python/.venv を実行してください。" >&2
  exit 1
fi

"$PYTHON_BIN" -m PyInstaller \
  --noconfirm \
  --clean \
  --onefile \
  --name pdf-engine \
  --target-architecture arm64 \
  --distpath "$BUILD_ROOT/dist" \
  --workpath "$BUILD_ROOT/work" \
  --specpath "$BUILD_ROOT" \
  --add-data "$PROJECT_ROOT/assets/fonts/NotoSansJP-Regular.ttf:assets/fonts" \
  "$PROJECT_ROOT/python/pdf_engine.py"

cp "$BUILD_ROOT/dist/pdf-engine" "$PROJECT_ROOT/src-tauri/binaries/pdf-engine-$TARGET_TRIPLE"
chmod +x "$PROJECT_ROOT/src-tauri/binaries/pdf-engine-$TARGET_TRIPLE"
echo "Created src-tauri/binaries/pdf-engine-$TARGET_TRIPLE"
