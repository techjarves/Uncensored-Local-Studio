$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
$runtimeDir = Join-Path $rootDir "app\tools\video-runtime"
$uvDir = Join-Path $runtimeDir "uv"
$uvExe = Join-Path $uvDir "uv.exe"
$venvDir = Join-Path $runtimeDir "venv"
$pythonExe = Join-Path $venvDir "Scripts\python.exe"
$requirements = Join-Path $scriptDir "video-requirements.txt"
$uvVersion = "0.11.21"
$uvArchive = Join-Path $runtimeDir "uv.zip"
$uvExtract = Join-Path $runtimeDir "uv-extract"

New-Item -ItemType Directory -Force -Path $runtimeDir, $uvDir | Out-Null
$env:UV_PYTHON_INSTALL_DIR = Join-Path $runtimeDir "python"
$env:UV_CACHE_DIR = Join-Path $runtimeDir "cache"

Write-Output '{"type":"runtime-progress","phase":"Preparing portable video runtime","progress":5}'

if (-not (Test-Path $uvExe)) {
    $url = "https://github.com/astral-sh/uv/releases/download/$uvVersion/uv-x86_64-pc-windows-msvc.zip"
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $uvArchive
    if (Test-Path $uvExtract) { Remove-Item $uvExtract -Recurse -Force }
    Expand-Archive -Path $uvArchive -DestinationPath $uvExtract -Force
    $found = Get-ChildItem $uvExtract -Filter "uv.exe" -Recurse | Select-Object -First 1
    if (-not $found) { throw "uv.exe was not found in the downloaded archive." }
    Copy-Item $found.FullName $uvExe -Force
    Remove-Item $uvArchive, $uvExtract -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output '{"type":"runtime-progress","phase":"Installing managed Python 3.11","progress":20}'
& $uvExe python install 3.11 --no-bin
if ($LASTEXITCODE -ne 0) { throw "Managed Python installation failed." }

Write-Output '{"type":"runtime-progress","phase":"Creating isolated environment","progress":35}'
if (Test-Path $pythonExe) {
    & $uvExe venv --python 3.11 --allow-existing $venvDir
} else {
    & $uvExe venv --python 3.11 $venvDir
}
if ($LASTEXITCODE -ne 0) { throw "Video virtual environment creation failed." }

Write-Output '{"type":"runtime-progress","phase":"Installing CUDA PyTorch","progress":50}'
& $uvExe pip install --python $pythonExe --index-url "https://download.pytorch.org/whl/cu126" "torch==2.7.1+cu126" "torchvision==0.22.1+cu126"
if ($LASTEXITCODE -ne 0) { throw "CUDA PyTorch installation failed." }

Write-Output '{"type":"runtime-progress","phase":"Installing video generation libraries","progress":72}'
& $uvExe pip install --python $pythonExe --requirement $requirements
if ($LASTEXITCODE -ne 0) { throw "Video generation dependency installation failed." }

Write-Output '{"type":"runtime-progress","phase":"Validating CUDA runtime","progress":92}'
& $pythonExe -c "import torch, diffusers, transformers, imageio_ffmpeg; assert torch.cuda.is_available(), 'CUDA is not available to PyTorch'; print(torch.__version__)"
if ($LASTEXITCODE -ne 0) { throw "Video runtime validation failed. Confirm that the NVIDIA driver supports CUDA 12.6." }

$marker = @{
    installedAt = (Get-Date).ToUniversalTime().ToString("o")
    python = "3.11"
    torch = "2.7.1+cu126"
    diffusers = "0.38.0"
    uv = $uvVersion
} | ConvertTo-Json
Set-Content -Path (Join-Path $runtimeDir "runtime.json") -Value $marker -Encoding UTF8
Write-Output '{"type":"runtime-progress","phase":"Video runtime ready","progress":100}'
