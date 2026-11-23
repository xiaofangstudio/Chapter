#!/usr/bin/env bash
set -euo pipefail

# 在 macOS 上生成通用（Intel + Apple Silicon）DMG / .app。
# 需要：Xcode Command Line Tools、Node 22、Rust stable。

cd "$(dirname "$0")/.."

if ! xcode-select -p >/dev/null 2>&1; then
  echo "请先安装 Xcode Command Line Tools：xcode-select --install" >&2
  exit 1
fi

if ! command -v rustup >/dev/null 2>&1; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
# shellcheck disable=SC1091
source "$HOME/.cargo/env"

rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm ci
npm run tauri build -- --target universal-apple-darwin --bundles dmg,app

BUNDLE="src-tauri/target/universal-apple-darwin/release/bundle"
echo
echo "构建完成："
find "$BUNDLE" -maxdepth 2 -type f \( -name '*.dmg' -o -name '*.app' \) -print
open "$BUNDLE/dmg" 2>/dev/null || true
