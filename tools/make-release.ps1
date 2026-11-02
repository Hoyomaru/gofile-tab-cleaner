# リリース用の ZIP (dist/gofile-tab-cleaner-v<version>.zip) を作る。
# 拡張機能の動作に必要なファイルだけを入れ、展開すると gofile-tab-cleaner/ フォルダになる。
# 実行: pwsh tools/make-release.ps1
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$version = (Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json).version

$files = @(
  'manifest.json', 'background.js', 'common.js', 'content.js',
  'popup.html', 'popup.css', 'popup.js', 'LICENSE', 'README.md'
)

$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'gofile-tab-cleaner'
$zip = Join-Path $dist "gofile-tab-cleaner-v$version.zip"

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null
foreach ($f in $files) { Copy-Item (Join-Path $root $f) $stage }
Copy-Item -Recurse (Join-Path $root 'icons') $stage

if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path $stage -DestinationPath $zip
Remove-Item -Recurse -Force $stage
Write-Output $zip
