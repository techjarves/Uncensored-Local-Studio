# Optional OpenVINO NPU setup for Intel AI Boost systems.
# This does not modify the existing stable-diffusion.cpp backends.

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
$venvDir = Join-Path $rootDir "app\tools\openvino-venv-win"
$pythonExe = Join-Path $venvDir "Scripts\python.exe"

Write-Host ""
Write-Host "  ============================================================"
Write-Host "   Local AI Image Generator - OpenVINO NPU Setup"
Write-Host "  ============================================================"
Write-Host ""

$npu = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like "*Intel(R) AI Boost*" -or ($_.Name -match "NPU" -and $_.PNPClass -eq "ComputeAccelerator") } |
  Select-Object -First 1

if (-not $npu) {
  Write-Host "  [ERROR] Intel AI Boost NPU was not detected on this system." -ForegroundColor Red
  exit 1
}

Write-Host "  Detected: $($npu.Name)"

if (-not (Test-Path $pythonExe)) {
  Write-Host "  Creating Python environment: $venvDir"
  python -m venv $venvDir
}

Write-Host "  Installing OpenVINO GenAI runtime..."
& $pythonExe -m pip install --upgrade pip
& $pythonExe -m pip install openvino openvino-genai pillow huggingface-hub

Write-Host ""
Write-Host "  Verifying OpenVINO NPU device..."
& $pythonExe -c "import openvino as ov; core=ov.Core(); print('Available devices:', core.available_devices); raise SystemExit(0 if 'NPU' in core.available_devices else 2)"

Write-Host ""
Write-Host "  ============================================================"
Write-Host "   OpenVINO NPU setup complete."
Write-Host "   Restart windows.bat, then download an OpenVINO NPU model."
Write-Host "  ============================================================"
Write-Host ""
