# Chapter 1.4.0 macOS 构建说明

Chapter 的 macOS 包必须在 macOS 上生成，因为 Tauri 需要 Apple SDK、`codesign`
和 `hdiutil`。Windows / Linux 无法交叉产出可用的 `.dmg`。

## 一条命令构建

在 macOS 14+ 上，安装 Xcode Command Line Tools 后：

```bash
bash scripts/build-macos.sh
```

脚本会：

1. 安装 Rust stable（若没有）。
2. 加入 `aarch64-apple-darwin` 与 `x86_64-apple-darwin` 两个 target。
3. 执行 `npm ci`。
4. 生成通用二进制并打包 `.app` 与 `.dmg`。

产物位于：

```text
src-tauri/target/universal-apple-darwin/release/bundle/dmg/
```

## GitHub Actions

仓库已包含 `.github/workflows/build-desktop.yml`。在 Actions 里手动运行
`Build desktop packages`，会同时产出：

- `Chapter-1.4.0-macos-universal`：通用架构 `.dmg`
- `Chapter-1.4.0-linux-x64`：`.deb` 与 `.AppImage`

## 签名

默认是未签名构建。首次打开时，macOS 可能提示“无法验证开发者”：

- 右键点击 Chapter.app，选择“打开”；或
- 在“系统设置 → 隐私与安全性”里允许打开。

要发布给公众，需要 Apple Developer ID 证书，并在 CI 中配置
`APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`，
再做 notarization。当前仓库没有证书，所以不会伪造签名。
