#!/usr/bin/env bash
set -euo pipefail

# 在 Ubuntu / Debian 上生成 .deb 与 .AppImage。
# 依赖：libwebkit2gtk-4.1-dev、libgtk-3-dev、libayatana-appindicator3-dev、
#       librsvg2-dev、patchelf、build-essential、Node 22、Rust stable。

cd "$(dirname "$0")/.."

if ! command -v cargo >/dev/null 2>&1; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
# shellcheck disable=SC1091
source "$HOME/.cargo/env"

npm ci
npm run tauri build -- --bundles deb,appimage

echo
echo "构建完成："
find src-tauri/target/release/bundle -maxdepth 2 -type f \( -name '*.deb' -o -name '*.AppImage' \) -print
