param(
    [Parameter(Mandatory = $true)][string]$Pfx,
    [Parameter(Mandatory = $true)][string]$Password,
    [switch]$SkipTrustVerify,
    [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$signtool = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe'
if (-not (Test-Path $signtool)) { throw "找不到 signtool: $signtool" }
if (-not (Test-Path $Pfx)) { throw "找不到证书: $Pfx" }

$files = @(
    'release\Chapter_1.7.0_Windows_x64_setup.exe',
    'release\Chapter_1.7.0_Windows_x64_portable.exe'
)

foreach ($rel in $files) {
    $file = Join-Path $Root $rel
    if (-not (Test-Path $file)) { throw "找不到安装包: $file" }

    & $signtool sign /f $Pfx /p $Password /fd sha256 /td sha256 /tr 'http://timestamp.digicert.com' $file
    if ($LASTEXITCODE -ne 0) { throw "签名失败: $rel" }

    if (-not $SkipTrustVerify) {
        & $signtool verify /pa /v $file
        if ($LASTEXITCODE -ne 0) { throw "签名校验失败: $rel" }
    } else {
        $sig = Get-AuthenticodeSignature $file
        if (-not $sig.SignerCertificate) { throw "未写入签名: $rel" }
    }
    Write-Output "已签名 $rel"
}
