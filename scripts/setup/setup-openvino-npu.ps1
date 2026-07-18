# Optional OpenVINO NPU setup for Intel AI Boost systems.
# Installs a portable Python runtime under app/tools/python-win.

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent (Split-Path -Parent $scriptDir)
$appDir = Join-Path $rootDir "app"
$toolsDir = Join-Path $appDir "tools"
$pythonDir = Join-Path $toolsDir "python-win"
$pythonExe = Join-Path $pythonDir "python.exe"
$pythonZip = Join-Path $toolsDir "python-win.zip"
$getPip = Join-Path $toolsDir "get-pip.py"

$pythonVersion = "3.11.9"
$pythonZipUrl = "https://www.python.org/ftp/python/$pythonVersion/python-$pythonVersion-embed-amd64.zip"
$getPipUrl = "https://bootstrap.pypa.io/get-pip.py"

function Enable-Tls12 {
  try {
    $tls12 = [Enum]::ToObject([Net.SecurityProtocolType], 3072)
    [Net.ServicePointManager]::SecurityProtocol =
      [Net.ServicePointManager]::SecurityProtocol -bor $tls12
  } catch {}
}

function Download-File {
  param([string]$Url, [string]$Dest, [string]$Label)
  Write-Host "  Downloading $Label..."
  Enable-Tls12
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Dest) | Out-Null
  $client = New-Object System.Net.WebClient
  $client.Headers.Add("User-Agent", "Uncensored-AI-Studio-Setup")
  $client.DownloadFile($Url, $Dest)
}

function Expand-Zip {
  param([string]$ZipPath, [string]$Destination)
  if (Test-Path $Destination) {
    Remove-Item $Destination -Recurse -Force -ErrorAction SilentlyContinue
  }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $Destination)
}

function Enable-EmbeddedPythonSitePackages {
  $pth = Get-ChildItem $pythonDir -Filter "python*._pth" | Select-Object -First 1
  if (-not $pth) { throw "Embedded Python ._pth file not found in $pythonDir" }

  $content = Get-Content $pth.FullName
  $hasSitePackages = $content | Where-Object { $_.Trim() -eq "Lib\site-packages" } | Select-Object -First 1
  $addedSitePackages = $false
  $next = foreach ($line in $content) {
    if (-not $hasSitePackages -and -not $addedSitePackages -and $line.Trim() -eq "import site") {
      "Lib\site-packages"
      $addedSitePackages = $true
    }
    if ($line.Trim() -eq "#import site") {
      if (-not $hasSitePackages -and -not $addedSitePackages) {
        "Lib\site-packages"
        $addedSitePackages = $true
      }
      "import site"
    } else {
      $line
    }
  }
  Set-Content -Path $pth.FullName -Value $next -Encoding ASCII
}

function Ensure-PortablePython {
  if (Test-Path $pythonExe) {
    try {
      & $pythonExe -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)"
      if ($LASTEXITCODE -eq 0) {
        Write-Host "  Portable Python already ready: $pythonExe"
        return
      }
    } catch {}

    Write-Host "  Existing portable Python is invalid. Reinstalling..."
    Remove-Item $pythonDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  Download-File -Url $pythonZipUrl -Dest $pythonZip -Label "Portable Python $pythonVersion"
  Expand-Zip -ZipPath $pythonZip -Destination $pythonDir
  Remove-Item $pythonZip -Force -ErrorAction SilentlyContinue
  Enable-EmbeddedPythonSitePackages

  Download-File -Url $getPipUrl -Dest $getPip -Label "pip bootstrap"
  & $pythonExe $getPip --no-warn-script-location
  if ($LASTEXITCODE -ne 0) { throw "pip bootstrap failed for portable Python." }
  Remove-Item $getPip -Force -ErrorAction SilentlyContinue

  & $pythonExe -m pip --version | Out-Host
}

Write-Host ""
Write-Host "  ============================================================"
Write-Host "   Uncensored AI Studio - OpenVINO NPU Setup"
Write-Host "   Portable Python runtime: app/tools/python-win"
Write-Host "  ============================================================"
Write-Host ""

$npu = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
  Where-Object {
    $name = [string]$_.Name
    $manufacturer = [string]$_.Manufacturer
    ($name -match "(?i)Intel.*(?:AI Boost|NPU)") -or
    (($manufacturer -match "(?i)Intel") -and ($name -match "(?i)(?:AI Boost|\bNPU\b)"))
  } |
  Select-Object -First 1

if (-not $npu) {
  Write-Host "  [ERROR] Intel AI Boost NPU was not detected on this system." -ForegroundColor Red
  exit 1
}

Write-Host "  Detected: $($npu.Name)"

Ensure-PortablePython

Write-Host "  Installing OpenVINO GenAI runtime into portable Python..."
& $pythonExe -m pip install --upgrade pip --no-warn-script-location --progress-bar off
if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed." }
& $pythonExe -m pip install openvino openvino-genai pillow huggingface-hub --no-warn-script-location --progress-bar off
if ($LASTEXITCODE -ne 0) { throw "OpenVINO package install failed." }

Write-Host ""
Write-Host "  Verifying OpenVINO NPU device..."
& $pythonExe -c "import openvino as ov; core=ov.Core(); print('Available devices:', core.available_devices); raise SystemExit(0 if 'NPU' in core.available_devices else 2)"
if ($LASTEXITCODE -ne 0) { throw "OpenVINO installed, but NPU was not available to the portable runtime." }

Write-Host ""
Write-Host "  ============================================================"
Write-Host "   OpenVINO NPU setup complete."
Write-Host "   Portable Python: $pythonExe"
Write-Host "   Restart windows.bat, then download an OpenVINO NPU model."
Write-Host "  ============================================================"
Write-Host ""
