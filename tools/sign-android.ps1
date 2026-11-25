param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$propsFile = Join-Path $Root '.signing\keystore.properties'
if (-not (Test-Path $propsFile)) { throw "缺少签名配置: $propsFile" }

$props = @{}
Get-Content $propsFile | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { $props[$matches[1]] = $matches[2] }
}

$sdk = 'D:\Android\sdk'
$buildTools = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory |
    Sort-Object Name -Descending | Select-Object -First 1
$zipalign = Join-Path $buildTools.FullName 'zipalign.exe'
$apksigner = Join-Path $buildTools.FullName 'apksigner.bat'

$items = @(
    @{ Target = 'x86_64'; Src = 'src-tauri\gen\android\app\build\outputs\apk\x86_64\release\app-x86_64-release-unsigned.apk'; Out = 'release\Chapter_1.7.0_Android_x86_64.apk' },
    @{ Target = 'arm64';  Src = 'src-tauri\gen\android\app\build\outputs\apk\arm64\release\app-arm64-release-unsigned.apk';   Out = 'release\Chapter_1.7.0_Android_arm64.apk' }
)

foreach ($item in $items) {
    $src = Join-Path $Root $item.Src
    $out = Join-Path $Root $item.Out
    if (-not (Test-Path $src)) { throw "找不到构建产物: $src" }

    $aligned = Join-Path $env:TEMP ("chapter-{0}-aligned.apk" -f $item.Target)
    & $zipalign -p -f 4 $src $aligned
    if ($LASTEXITCODE -ne 0) { throw 'zipalign 失败' }

    & $apksigner sign `
        --ks (Join-Path $Root '.signing\chapter-release.jks') `
        --ks-key-alias $props['keyAlias'] `
        --ks-pass ("pass:" + $props['storePassword']) `
        --key-pass ("pass:" + $props['keyPassword']) `
        --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true `
        --out $out $aligned
    if ($LASTEXITCODE -ne 0) { throw "apksigner 失败: $($item.Target)" }

    & $apksigner verify --verbose $out
    if ($LASTEXITCODE -ne 0) { throw "签名校验失败: $($item.Target)" }
    Remove-Item -Force $aligned
    Write-Output ("已签名 {0} -> {1}" -f $item.Target, $item.Out)
}
