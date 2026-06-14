# scripts/reset.ps1
# Resets portable app dependencies/builds while preserving user models and outputs.

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir   = Split-Path -Parent $scriptDir
$appDir    = Join-Path $rootDir "app"

Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Yellow
Write-Host "   Resetting Local-AI-Image-Generator..." -ForegroundColor Yellow
Write-Host "  ============================================================" -ForegroundColor Yellow
Write-Host ""

# Delete tools/node
$toolsDir = Join-Path $appDir "tools"
if (Test-Path $toolsDir) {
    Write-Host "   >> Removing portable tools/ node folder..." -ForegroundColor Cyan
    Remove-Item $toolsDir -Recurse -Force -ErrorAction SilentlyContinue
}

# Delete backend
$backendDir = Join-Path $appDir "backend"
if (Test-Path $backendDir) {
    Write-Host "   >> Removing backend binaries..." -ForegroundColor Cyan
    Remove-Item $backendDir -Recurse -Force -ErrorAction SilentlyContinue
}

# Delete dist
$distDir = Join-Path $appDir "dist"
if (Test-Path $distDir) {
    Write-Host "   >> Removing dist/ build folder..." -ForegroundColor Cyan
    Remove-Item $distDir -Recurse -Force -ErrorAction SilentlyContinue
}

# Preserve models
$modelsDir = Join-Path $appDir "models"
if (Test-Path $modelsDir) {
    Write-Host "   >> Preserving downloaded models in app/models." -ForegroundColor Cyan
}

# Delete node_modules in frontend
$nodeModulesDir = Join-Path $appDir "frontend\node_modules"
if (Test-Path $nodeModulesDir) {
    Write-Host "   >> Removing frontend node_modules..." -ForegroundColor Cyan
    Remove-Item $nodeModulesDir -Recurse -Force -ErrorAction SilentlyContinue
}

$nodeModulesMac = Join-Path $appDir "frontend\node_modules_mac"
if (Test-Path $nodeModulesMac) {
    Write-Host "   >> Removing frontend node_modules_mac..." -ForegroundColor Cyan
    Remove-Item $nodeModulesMac -Recurse -Force -ErrorAction SilentlyContinue
}

$nodeModulesLinux = Join-Path $appDir "frontend\node_modules_linux"
if (Test-Path $nodeModulesLinux) {
    Write-Host "   >> Removing frontend node_modules_linux..." -ForegroundColor Cyan
    Remove-Item $nodeModulesLinux -Recurse -Force -ErrorAction SilentlyContinue
}


# Delete package-lock.json in frontend
$lockFile = Join-Path $appDir "frontend\package-lock.json"
if (Test-Path $lockFile) {
    Write-Host "   >> Removing frontend package-lock.json..." -ForegroundColor Cyan
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Green
Write-Host "   Reset complete. Models and generated outputs were preserved." -ForegroundColor Green
Write-Host "  ============================================================" -ForegroundColor Green
Write-Host ""
Read-Host "  Press Enter to close..."
