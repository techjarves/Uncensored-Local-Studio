# Uncensored AI Studio - Setup Script
# scripts/setup/ lives under root, app/ is a root sibling of scripts/

$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir     = Split-Path -Parent (Split-Path -Parent $scriptDir)
$appDir      = Join-Path $rootDir "app"
$frontendDir = Join-Path $appDir  "frontend"
$toolsDir    = Join-Path $appDir  "tools"
$nodeDir     = Join-Path $toolsDir "node-win"
$nodeExe     = Join-Path $nodeDir  "node.exe"
$npmCmd      = Join-Path $nodeDir  "npm.cmd"
$distDir     = Join-Path $appDir   "dist"

# ── Helpers ───────────────────────────────────────────────────────────────────
function Print-Header {
    Write-Host ""
    Write-Host "  ============================================================" -ForegroundColor Cyan
    Write-Host "   UNCENSORED AI STUDIO      -  First-Time Setup" -ForegroundColor Cyan
    Write-Host "   100% Self-Contained  |  No System Install Required" -ForegroundColor DarkCyan
    Write-Host "  ============================================================" -ForegroundColor Cyan
    Write-Host ""
}

function Print-Step {
    param([int]$n, [int]$total, [string]$title)
    Write-Host ""
    Write-Host "  [$n/$total] $title" -ForegroundColor White
    Write-Host ("  " + "-" * 56) -ForegroundColor DarkGray
}

function Print-OK   { param([string]$m); Write-Host "   OK  $m" -ForegroundColor Green }
function Print-Info { param([string]$m); Write-Host "   >>  $m" -ForegroundColor Cyan }
function Print-Warn { param([string]$m); Write-Host "   !!  $m" -ForegroundColor Yellow }
function Print-Fail { param([string]$m); Write-Host "   XX  $m" -ForegroundColor Red }

function Format-Bytes {
    param([long]$b)
    if ($b -gt 1GB) { return "{0:N2} GB" -f ($b / 1GB) }
    if ($b -gt 1MB) { return "{0:N1} MB" -f ($b / 1MB) }
    return "{0:N0} KB" -f ($b / 1KB)
}

function Format-Speed {
    param([double]$bps)
    if ($bps -gt 1MB) { return "{0:N1} MB/s" -f ($bps / 1MB) }
    return "{0:N0} KB/s" -f ($bps / 1KB)
}

function Enable-Tls12 {
    try {
        # Use the protocol's numeric value because older .NET enum definitions
        # do not expose the Tls12 member even when Windows supports TLS 1.2.
        $tls12 = [Enum]::ToObject([Net.SecurityProtocolType], 3072)
        [Net.ServicePointManager]::SecurityProtocol =
            [Net.ServicePointManager]::SecurityProtocol -bor $tls12
    } catch {
        throw "TLS 1.2 could not be enabled. This setup requires 64-bit Windows 10 or Windows 11 with current system updates. $($_.Exception.Message)"
    }
}

function Invoke-RichDownload {
    param([string]$Url, [string]$Dest, [string]$Label)
    Print-Info "Downloading: $Label"
    Write-Host ""

    $barWidth  = 48

    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $lastBytes = [long]0
        $lastTime  = [DateTime]::Now
        $resp = $null
        $stream = $null
        $out = $null

        try {
            if (Test-Path $Dest) { Remove-Item $Dest -Force }
            Enable-Tls12
            $req    = [System.Net.HttpWebRequest]::Create($Url)
            $req.UserAgent = "Mozilla/5.0"
            $req.Timeout = 300000
            $req.ReadWriteTimeout = 300000
            $resp   = $req.GetResponse()
            $total  = [long]$resp.ContentLength
            $stream = $resp.GetResponseStream()
            $out    = [System.IO.File]::Create($Dest)
            $buf    = New-Object byte[] 65536
            $done   = [long]0

            while ($true) {
                $read = $stream.Read($buf, 0, $buf.Length)
                if ($read -le 0) { break }
                $out.Write($buf, 0, $read)
                $done += $read

                $now     = [DateTime]::Now
                $elapsed = ($now - $lastTime).TotalSeconds
                if ($elapsed -ge 0.35) {
                    $speed     = ($done - $lastBytes) / $elapsed
                    $lastBytes = $done
                    $lastTime  = $now
                    $pct  = if ($total -gt 0) { [int](($done / $total) * 100) } else { 0 }
                    $fill = [int](($pct / 100) * $barWidth)
                    $bar  = ("#" * $fill) + ("-" * ($barWidth - $fill))

                    $eta = ""
                    if ($speed -gt 0 -and $total -gt 0) {
                        $rem = [int](($total - $done) / $speed)
                        $eta = "  ETA $([int]($rem/60))m$($rem%60)s"
                    }

                    $dl  = Format-Bytes $done
                    $tot = if ($total -gt 0) { " / " + (Format-Bytes $total) } else { "" }
                    $spd = Format-Speed $speed
                    Write-Host -NoNewline "`r  [$bar] $pct%  $dl$tot  $spd$eta   "
                }
            }

            if ($total -gt 0 -and $done -ne $total) {
                throw "Download ended early: $(Format-Bytes $done) of $(Format-Bytes $total) received."
            }

            Write-Host "`r  [$("#" * $barWidth)] 100%  $(Format-Bytes $done)  Done!                         " -ForegroundColor Green
            Write-Host ""
            return $true
        } catch {
            Write-Host ""
            if ($attempt -lt 3) {
                Print-Warn "Download attempt $attempt failed: $_"
                Print-Info "Retrying download..."
                Start-Sleep -Seconds (2 * $attempt)
            } else {
                Print-Fail "Download failed after $attempt attempts: $_"
            }
        } finally {
            if ($out) { $out.Close() }
            if ($stream) { $stream.Close() }
            if ($resp) { $resp.Close() }
        }

        if (Test-Path $Dest) { Remove-Item $Dest -Force -ErrorAction SilentlyContinue }
    }

    return $false
}

function Expand-WithProgress {
    param([string]$ZipPath, [string]$Destination, [string]$Label)
    Print-Info "Extracting $Label..."
    Write-Host ""

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip   = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    $total = $zip.Entries.Count
    $barW  = 48
    $i = 0

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null

    foreach ($entry in $zip.Entries) {
        $i++
        $pct  = [int](($i / $total) * 100)
        $fill = [int](($pct / 100) * $barW)
        $bar  = ("#" * $fill) + ("-" * ($barW - $fill))
        $name = $entry.Name
        if ($name.Length -gt 28) { $name = "..." + $name.Substring($name.Length - 28) }
        Write-Host -NoNewline "`r  [$bar] $pct%  $name                    "

        if ($entry.FullName.EndsWith("/") -or $entry.FullName.EndsWith("\")) {
            New-Item -ItemType Directory -Force -Path (Join-Path $Destination $entry.FullName) | Out-Null
        } else {
            $destFile = Join-Path $Destination $entry.FullName
            $destDir  = Split-Path -Parent $destFile
            New-Item -ItemType Directory -Force -Path $destDir | Out-Null
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destFile, $true)
        }
    }

    $zip.Dispose()
    Write-Host "`r  [$("#" * $barW)] 100%  $total files extracted!                    " -ForegroundColor Green
    Write-Host ""
}

# ══════════════════════════════════════════════════════════════════════════════
Print-Header

$steps = 8

# ── Step 1: Portable Node.js ──────────────────────────────────────────────────
Print-Step 1 $steps "Setting up portable Node.js (app/tools/node-win/)"

$nodeReady = $false
if ((Test-Path $nodeExe) -and (Test-Path $npmCmd)) {
    try {
        $v = & $nodeExe --version
        # Test if npm is functional (doesn't throw parsing/unexpected token errors)
        $npmTest = & $nodeExe (Join-Path $nodeDir "node_modules\npm\bin\npm-cli.js") --version 2>&1
        if ($LASTEXITCODE -eq 0 -and $npmTest -match "^\d+\.\d+\.\d+") {
            $nodeReady = $true
            Print-OK "Portable Node.js already ready: $v"
        }
    } catch {}
}

if (-not $nodeReady) {
    if (Test-Path $nodeDir) {
        Print-Warn "Portable Node.js installation is corrupted or incomplete. Cleaning up..."
        Remove-Item $nodeDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    $nodeZip = Join-Path $toolsDir "node.zip"
    New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

    $ok = Invoke-RichDownload `
        -Url  "https://nodejs.org/dist/v22.12.0/node-v22.12.0-win-x64.zip" `
        -Dest $nodeZip `
        -Label "Node.js v22.12.0 LTS (Portable ZIP)"

    if (-not $ok) { Print-Fail "Cannot download Node.js."; Read-Host; exit 1 }

    Expand-WithProgress -ZipPath $nodeZip -Destination $toolsDir -Label "Node.js"
    Remove-Item $nodeZip -Force

    $extracted = Get-ChildItem $toolsDir -Directory | Where-Object { $_.Name -like "node-v*" } | Select-Object -First 1
    if ($extracted) {
        if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
        Rename-Item $extracted.FullName "node-win"
    }

    # Pause briefly to allow USB drive writes to flush
    Print-Info "Waiting for disk to flush..."
    Start-Sleep -Seconds 3

    # Re-verify
    $nodeReady = $false
    if ((Test-Path $nodeExe) -and (Test-Path $npmCmd)) {
        try {
            $v = & $nodeExe --version
            $npmTest = & $nodeExe (Join-Path $nodeDir "node_modules\npm\bin\npm-cli.js") --version 2>&1
            if ($LASTEXITCODE -eq 0 -and $npmTest -match "^\d+\.\d+\.\d+") {
                $nodeReady = $true
            }
        } catch {}
    }

    if (-not $nodeReady) {
        Print-Fail "Portable Node.js install is incomplete or corrupted. Close any running Uncensored AI Studio windows, delete app/tools/node-win, then run setup again."
        Read-Host; exit 1
    }

    Print-OK "Portable Node.js ready: $v"
}

# ── Step 2: stable-diffusion.cpp GPU Backend (Dynamic Detection) ──────────────
$hasNvidia = $false
try {
    $gpus = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
    foreach ($gpu in $gpus) {
        if ($gpu.Name -like "*NVIDIA*") {
            $hasNvidia = $true
        }
    }
} catch {}
if (-not $hasNvidia) {
    try {
        & nvidia-smi *> $null
        if ($LASTEXITCODE -eq 0) { $hasNvidia = $true }
    } catch {}
}

Print-Step 2 $steps "Setting up stable-diffusion.cpp CPU backend (app/backend/win/cpu/)"
$cpuBackendDest = Join-Path $appDir "backend\win\cpu"
$cpuBackendExe  = Join-Path $cpuBackendDest "sd-cpu.exe"
$cpuBackendDll  = Join-Path $cpuBackendDest "stable-diffusion.dll"

if ((Test-Path $cpuBackendExe) -and (Test-Path $cpuBackendDll)) {
    Print-OK "CPU backend binaries already ready."
} else {
    $cpuBackendZip = Join-Path $toolsDir "sd-cpu.zip"
    New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
    New-Item -ItemType Directory -Force -Path $cpuBackendDest | Out-Null

    $ok = Invoke-RichDownload `
        -Url  "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-721-8caa3f9/sd-master-8caa3f9-bin-win-avx2-x64.zip" `
        -Dest $cpuBackendZip `
        -Label "stable-diffusion.cpp CPU Backend (Windows x64 AVX2)"

    if (-not $ok) { Print-Fail "Cannot download CPU backend binaries."; Read-Host; exit 1 }

    $tempExt = Join-Path $toolsDir "sd-cpu-temp"
    Expand-WithProgress -ZipPath $cpuBackendZip -Destination $tempExt -Label "CPU Backend"
    Remove-Item $cpuBackendZip -Force

    if (Test-Path $tempExt) {
        $extractedExe = Join-Path $tempExt "bin\sd-server.exe"
        if (-not (Test-Path $extractedExe)) { $extractedExe = Join-Path $tempExt "sd-server.exe" }
        if (-not (Test-Path $extractedExe)) { $extractedExe = Join-Path $tempExt "bin\sd.exe" }
        if (-not (Test-Path $extractedExe)) { $extractedExe = Join-Path $tempExt "sd.exe" }

        $extractedDll = Join-Path $tempExt "bin\stable-diffusion.dll"
        if (-not (Test-Path $extractedDll)) { $extractedDll = Join-Path $tempExt "stable-diffusion.dll" }

        if (Test-Path $extractedExe) { Copy-Item $extractedExe $cpuBackendExe -Force }
        if (Test-Path $extractedDll) { Copy-Item $extractedDll $cpuBackendDll -Force }

        Get-ChildItem $tempExt -Filter "*.dll" -Recurse | ForEach-Object { Copy-Item $_.FullName $cpuBackendDest -Force }
        Get-ChildItem $tempExt -Filter "*.exe" -Recurse | ForEach-Object {
            if ($_.FullName -ne $extractedExe) { Copy-Item $_.FullName $cpuBackendDest -Force }
        }
        Remove-Item $tempExt -Recurse -Force
    }

    if ((Test-Path $cpuBackendExe) -and (Test-Path $cpuBackendDll)) {
        Print-OK "CPU backend binaries installed successfully!"
    } else {
        Print-Fail "Failed to copy backend binaries to app/backend/win/cpu/."
        Read-Host; exit 1
    }
}

if ($hasNvidia) {
    Print-Step 2 $steps "Setting up stable-diffusion.cpp CUDA GPU backend (app/backend/win/cuda/)"
    $backendDest = Join-Path $appDir "backend\win\cuda"
    $backendExe  = Join-Path $backendDest "sd-cuda.exe"
    $backendDll  = Join-Path $backendDest "stable-diffusion.dll"
    $cudaBackendReady = $false
    
    if ((Test-Path $backendExe) -and (Test-Path $backendDll)) {
        Print-OK "CUDA GPU backend binaries already ready."
        $cudaBackendReady = $true
    } else {
        $backendZip = Join-Path $toolsDir "sd-cuda.zip"
        New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
        New-Item -ItemType Directory -Force -Path $backendDest | Out-Null

        $ok = Invoke-RichDownload `
            -Url  "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-721-8caa3f9/sd-master-8caa3f9-bin-win-cuda12-x64.zip" `
            -Dest $backendZip `
            -Label "stable-diffusion.cpp CUDA Backend (Windows x64)"

        if (-not $ok) {
            Print-Warn "Cannot download CUDA backend binaries. Continuing with the Vulkan backend fallback."
        } else {
            $tempExt = Join-Path $toolsDir "sd-cuda-temp"
            Expand-WithProgress -ZipPath $backendZip -Destination $tempExt -Label "CUDA Backend"
            Remove-Item $backendZip -Force

            # Move files and rename sd.exe/sd-server.exe to sd-cuda.exe
            if (Test-Path $tempExt) {
                $extractedExe = Join-Path $tempExt "bin\sd-server.exe"
                if (-not (Test-Path $extractedExe)) { $extractedExe = Join-Path $tempExt "sd-server.exe" }
                if (-not (Test-Path $extractedExe)) { $extractedExe = Join-Path $tempExt "bin\sd.exe" }
                if (-not (Test-Path $extractedExe)) { $extractedExe = Join-Path $tempExt "sd.exe" }
                
                $extractedDll = Join-Path $tempExt "bin\stable-diffusion.dll"
                if (-not (Test-Path $extractedDll)) { $extractedDll = Join-Path $tempExt "stable-diffusion.dll" }

                if (Test-Path $extractedExe) { Copy-Item $extractedExe $backendExe -Force }
                if (Test-Path $extractedDll) { Copy-Item $extractedDll $backendDll -Force }
                
                # Copy any other DLLs or EXEs
                Get-ChildItem $tempExt -Filter "*.dll" -Recurse | ForEach-Object { Copy-Item $_.FullName $backendDest -Force }
                Get-ChildItem $tempExt -Filter "*.exe" -Recurse | ForEach-Object {
                    if ($_.FullName -ne $extractedExe) { Copy-Item $_.FullName $backendDest -Force }
                }
                Remove-Item $tempExt -Recurse -Force
            }

            if ((Test-Path $backendExe) -and (Test-Path $backendDll)) {
                Print-OK "CUDA GPU backend binaries installed successfully!"
                $cudaBackendReady = $true
            } else {
                Print-Warn "Failed to copy CUDA backend binaries. Continuing with the Vulkan backend fallback."
            }
        }
    }

    if ($cudaBackendReady) {
        $cudaDllsExist = (Test-Path (Join-Path $backendDest "cublas64_12.dll")) -and `
                         (Test-Path (Join-Path $backendDest "cublasLt64_12.dll")) -and `
                         (Test-Path (Join-Path $backendDest "cudart64_12.dll"))

        if (-not $cudaDllsExist) {
            Print-Info "CUDA runtime DLLs are missing from backend folder. Downloading portable CUDA v12 runtime..."
            $dllZip = Join-Path $toolsDir "cuda-dlls.zip"
            $ok = Invoke-RichDownload `
                -Url  "https://github.com/ggml-org/llama.cpp/releases/download/b9509/cudart-llama-bin-win-cuda-12.4-x64.zip" `
                -Dest $dllZip `
                -Label "CUDA v12 Runtime DLLs (llama.cpp)"

            if ($ok) {
                Expand-WithProgress -ZipPath $dllZip -Destination $backendDest -Label "CUDA Runtime DLLs"
                Remove-Item $dllZip -Force
                Print-OK "CUDA runtime DLLs set up successfully!"
            } else {
                Print-Warn "Could not download portable CUDA runtime DLLs automatically. If the app fails to start in CUDA mode, you may need to install the CUDA Toolkit manually."
            }
        }
    }

    Print-Step 2 $steps "Setting up stable-diffusion.cpp Vulkan GPU backend for comparison (app/backend/win/vulkan/)"
    $backendDest = Join-Path $appDir "backend\win\vulkan"
    $backendExe  = Join-Path $backendDest "sd-vulkan.exe"
    $backendDll  = Join-Path $backendDest "stable-diffusion.dll"

    if ((Test-Path $backendExe) -and (Test-Path $backendDll)) {
        Print-OK "Vulkan GPU backend binaries already ready."
    } else {
        $backendZip = Join-Path $toolsDir "sd-vulkan.zip"
        New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
        New-Item -ItemType Directory -Force -Path $backendDest | Out-Null

        $ok = Invoke-RichDownload `
            -Url  "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-669-2d40a8b/sd-master-2d40a8b-bin-win-vulkan-x64.zip" `
            -Dest $backendZip `
            -Label "stable-diffusion.cpp Vulkan Backend (Windows x64)"

        if (-not $ok) { Print-Fail "Cannot download Vulkan backend binaries."; Read-Host; exit 1 }

        $tempExt = Join-Path $toolsDir "sd-vulkan-temp"
        Expand-WithProgress -ZipPath $backendZip -Destination $tempExt -Label "Vulkan Backend"
        Remove-Item $backendZip -Force

        if (Test-Path $tempExt) {
            $extractedExe = Join-Path $tempExt "bin\sd-server.exe"
            if (-not (Test-Path $extractedExe)) { $extractedExe = Join-Path $tempExt "sd-server.exe" }
            if (-not (Test-Path $extractedExe)) { $extractedExe = Join-Path $tempExt "bin\sd.exe" }
            if (-not (Test-Path $extractedExe)) { $extractedExe = Join-Path $tempExt "sd.exe" }

            $extractedDll = Join-Path $tempExt "bin\stable-diffusion.dll"
            if (-not (Test-Path $extractedDll)) { $extractedDll = Join-Path $tempExt "stable-diffusion.dll" }

            if (Test-Path $extractedExe) { Copy-Item $extractedExe $backendExe -Force }
            if (Test-Path $extractedDll) { Copy-Item $extractedDll $backendDll -Force }

            Get-ChildItem $tempExt -Filter "*.dll" -Recurse | ForEach-Object { Copy-Item $_.FullName $backendDest -Force }
            Get-ChildItem $tempExt -Filter "*.exe" -Recurse | ForEach-Object {
                if ($_.FullName -ne $extractedExe) { Copy-Item $_.FullName $backendDest -Force }
            }
            Remove-Item $tempExt -Recurse -Force
        }

        if ((Test-Path $backendExe) -and (Test-Path $backendDll)) {
            Print-OK "Vulkan GPU backend binaries installed successfully!"
        } else {
            Print-Fail "Failed to copy backend binaries to app/backend/win/vulkan/."
            Read-Host; exit 1
        }
    }
} else {
    Print-Step 2 $steps "Setting up stable-diffusion.cpp Vulkan GPU backend (app/backend/win/vulkan/)"
    $backendDest = Join-Path $appDir "backend\win\vulkan"
    $backendExe  = Join-Path $backendDest "sd-vulkan.exe"
    $backendDll  = Join-Path $backendDest "stable-diffusion.dll"
    
    if ((Test-Path $backendExe) -and (Test-Path $backendDll)) {
        Print-OK "Vulkan GPU backend binaries already ready."
    } else {
        $backendZip = Join-Path $toolsDir "sd-vulkan.zip"
        New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
        New-Item -ItemType Directory -Force -Path $backendDest | Out-Null

        $ok = Invoke-RichDownload `
            -Url  "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-669-2d40a8b/sd-master-2d40a8b-bin-win-vulkan-x64.zip" `
            -Dest $backendZip `
            -Label "stable-diffusion.cpp Vulkan Backend (Windows x64)"

        if (-not $ok) { Print-Fail "Cannot download Vulkan backend binaries."; Read-Host; exit 1 }

        $tempExt = Join-Path $toolsDir "sd-vulkan-temp"
        Expand-WithProgress -ZipPath $backendZip -Destination $tempExt -Label "Vulkan Backend"
        Remove-Item $backendZip -Force

        # Move files and rename sd.exe/sd-server.exe to sd-vulkan.exe
        if (Test-Path $tempExt) {
            $extractedExe = Join-Path $tempExt "bin\sd-server.exe"
            if (-not (Test-Path $extractedExe)) { $extractedExe = Join-Path $tempExt "sd-server.exe" }
            if (-not (Test-Path $extractedExe)) { $extractedExe = Join-Path $tempExt "bin\sd.exe" }
            if (-not (Test-Path $extractedExe)) { $extractedExe = Join-Path $tempExt "sd.exe" }
            
            $extractedDll = Join-Path $tempExt "bin\stable-diffusion.dll"
            if (-not (Test-Path $extractedDll)) { $extractedDll = Join-Path $tempExt "stable-diffusion.dll" }

            if (Test-Path $extractedExe) { Copy-Item $extractedExe $backendExe -Force }
            if (Test-Path $extractedDll) { Copy-Item $extractedDll $backendDll -Force }
            
            # Copy any other DLLs or EXEs
            Get-ChildItem $tempExt -Filter "*.dll" -Recurse | ForEach-Object { Copy-Item $_.FullName $backendDest -Force }
            Get-ChildItem $tempExt -Filter "*.exe" -Recurse | ForEach-Object {
                if ($_.FullName -ne $extractedExe) { Copy-Item $_.FullName $backendDest -Force }
            }
            Remove-Item $tempExt -Recurse -Force
        }

        if ((Test-Path $backendExe) -and (Test-Path $backendDll)) {
            Print-OK "Vulkan GPU backend binaries installed successfully!"
        } else {
            Print-Fail "Failed to copy backend binaries to app/backend/win/vulkan/."
            Read-Host; exit 1
        }
    }
}

# ── Step 3: npm install ───────────────────────────────────────────────────────
Print-Step 3 $steps "Setting up llama.cpp text backends (Vulkan + CPU)"
& (Join-Path $scriptDir "setup-llama.ps1")
if (-not $?) {
    Print-Fail "llama.cpp setup failed."
    Read-Host; exit 1
}

Print-Step 4 $steps "Setting up whisper.cpp speech backend"
& (Join-Path $scriptDir "setup-whisper.ps1")
if (-not $?) {
    Print-Fail "whisper.cpp setup failed."
    Read-Host; exit 1
}

Print-Step 5 $steps "Setting up Kokoro ONNX text-to-speech runtime"
& (Join-Path $scriptDir "setup-tts.ps1")
if (-not $?) {
    Print-Fail "Kokoro TTS setup failed."
    Read-Host; exit 1
}

$npu = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*Intel(R) AI Boost*" -or ($_.Name -match "NPU" -and $_.PNPClass -eq "ComputeAccelerator") } |
    Select-Object -First 1

Print-Step 6 $steps "Setting up portable OpenVINO NPU runtime"
if ($npu) {
    & (Join-Path $scriptDir "setup-openvino-npu.ps1")
    if (-not $?) {
        Print-Fail "OpenVINO NPU setup failed."
        Read-Host; exit 1
    }
} else {
    Print-Info "Intel AI Boost NPU not detected. Skipping OpenVINO NPU runtime."
}

Print-Step 7 $steps "Installing frontend dependencies (app/frontend/)"
Write-Host ""

if (-not (Test-Path $npmCmd)) {
    Print-Fail "npm.cmd was not found at $npmCmd"
    Print-Fail "Close any running Uncensored AI Studio windows, delete app/tools/node-win, then run setup again."
    Read-Host; exit 1
}

# If node_modules is a Unix symlink/junction, remove it so Windows can install natively into a real directory
$nodeModulesDir = Join-Path $frontendDir "node_modules"
$activeOsFile = Join-Path $frontendDir ".active_modules_os"
$prevOs = ""
if (Test-Path $activeOsFile) {
    $prevOs = (Get-Content $activeOsFile -Raw).Trim()
}

if (Test-Path $nodeModulesDir) {
    $item = Get-Item $nodeModulesDir
    if ($item.Attributes -match "ReparsePoint") {
        Print-Info "Removing Unix symlink for node_modules on Windows..."
        Remove-Item $nodeModulesDir -Force -ErrorAction SilentlyContinue
    } elseif ($prevOs -ne "windows" -and $prevOs -ne "") {
        # It's a real folder, but it belongs to another OS (e.g. linux or mac)
        Print-Info "Swapping out node_modules to node_modules_$prevOs..."
        $targetDir = Join-Path $frontendDir "node_modules_$prevOs"
        if (Test-Path $targetDir) { Remove-Item $targetDir -Recurse -Force -ErrorAction SilentlyContinue }
        Move-Item $nodeModulesDir $targetDir -Force
    }
}

# Now swap in node_modules_windows if it exists
$winModulesDir = Join-Path $frontendDir "node_modules_windows"
if ((Test-Path $winModulesDir) -and -not (Test-Path $nodeModulesDir)) {
    Print-Info "Swapping in node_modules_windows..."
    Move-Item $winModulesDir $nodeModulesDir -Force
}

# Mark windows as active
"windows" | Out-File -FilePath $activeOsFile -NoNewline -Encoding utf8

Push-Location $frontendDir
$oldPath = $env:PATH
try {
    $env:PATH = "$nodeDir;$env:PATH"
    & $npmCmd install --prefer-offline --loglevel=error
    if ($LASTEXITCODE -ne 0) {
        Print-Fail "npm install failed."
        Read-Host; exit 1
    }
    Write-Host ""
    Print-OK "Dependencies installed!"

    # ── Step 4: Build frontend ────────────────────────────────────────────────
    Print-Step 8 $steps "Building frontend -> app/dist/"
    Write-Host ""

    & $npmCmd run build
    if ($LASTEXITCODE -ne 0) {
        Print-Fail "Frontend build failed."
        Read-Host; exit 1
    }
    Write-Host ""
    Print-OK "Frontend built!"
} finally {
    $env:PATH = $oldPath
    Pop-Location
}

# ── Done ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Green
Write-Host "   Setup complete! Just double-click windows.bat to launch." -ForegroundColor Green
Write-Host "  ============================================================" -ForegroundColor Green
Write-Host ""
Read-Host "  Press Enter to close..."
