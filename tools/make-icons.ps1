# 拡張機能アイコン (icons/icon{16,32,48,128}.png) を生成する。
# 青い角丸の背景に、重なった2枚のタブとチェックマーク。
# 実行: pwsh tools/make-icons.ps1
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force $outDir | Out-Null

function New-RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [Math]::Max($r * 2, 0.01)
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# 128px 基準の座標で描き、サイズに合わせて縮尺する
function Draw-Tab($g, [float]$s, [float]$ox, [float]$oy, $brush) {
  $g.FillPath($brush, (New-RoundRect (($ox) * $s) (($oy + 10) * $s) (72 * $s) (54 * $s) (7 * $s)))
  $g.FillPath($brush, (New-RoundRect (($ox) * $s) (($oy) * $s) (32 * $s) (18 * $s) (6 * $s)))
}

foreach ($size in 16, 32, 48, 128) {
  $s = $size / 128
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)

  $blue = [System.Drawing.Color]::FromArgb(255, 37, 99, 235)
  $g.FillPath((New-Object System.Drawing.SolidBrush $blue), (New-RoundRect 0 0 ($size - 0.5) ($size - 0.5) (28 * $s)))

  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $whiteSoft = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(115, 255, 255, 255))
  Draw-Tab $g $s 40 24 $whiteSoft   # 後ろのタブ
  Draw-Tab $g $s 22 46 $white       # 手前のタブ

  # チェックマーク
  $pen = New-Object System.Drawing.Pen $blue, ([Math]::Max(9 * $s, 1.6))
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  $pts = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF (40 * $s), (86 * $s)),
    (New-Object System.Drawing.PointF (53 * $s), (98 * $s)),
    (New-Object System.Drawing.PointF (77 * $s), (73 * $s))
  )
  $g.DrawLines($pen, $pts)

  $g.Dispose()
  $bmp.Save((Join-Path $outDir "icon$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
Write-Output "icons written to $outDir"
