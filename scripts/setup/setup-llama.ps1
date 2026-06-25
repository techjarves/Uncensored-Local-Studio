param([string]$Release = "b9668")

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent (Split-Path -Parent $scriptDir)
$appDir = Join-Path $rootDir "app"
$toolsDir = Join-Path $appDir "tools"
$llmRoot = Join-Path $appDir "llm-backend\win"

function Enable-Tls12 {
    try {
        $tls12 = [Enum]::ToObject([Net.SecurityProtocolType], 3072)
        [Net.ServicePointManager]::SecurityProtocol =
            [Net.ServicePointManager]::SecurityProtocol -bor $tls12
    } catch {
        throw "TLS 1.2 could not be enabled: $($_.Exception.Message)"
    }
}

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

function Download-File {
    param([string]$Url, [string]$DestPath, [string]$Label)
    
    $barWidth  = 48

    Write-Host "   >>  Downloading $Label..."

    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $lastBytes = [long]0
        $lastTime  = [DateTime]::Now
        $resp = $null
        $stream = $null
        $out = $null

        try {
            if (Test-Path $DestPath) { Remove-Item $DestPath -Force }
            Enable-Tls12
            $req    = [System.Net.HttpWebRequest]::Create($Url)
            $req.UserAgent = "Mozilla/5.0"
            $req.Timeout = 300000
            $req.ReadWriteTimeout = 300000
            $resp   = $req.GetResponse()
            $total  = [long]$resp.ContentLength
            $stream = $resp.GetResponseStream()
            $out    = [System.IO.File]::Create($DestPath)
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
                    Write-Host -NoNewline "`r      [$bar] $pct%  $dl$tot  $spd$eta   "
                }
            }

            if ($total -gt 0 -and $done -ne $total) {
                throw "Download ended early: $(Format-Bytes $done) of $(Format-Bytes $total) received."
            }

            Write-Host "`r      [$("#" * $barWidth)] 100%  $(Format-Bytes $done)  Done!                         " -ForegroundColor Green
            Write-Host ""
            return
        } catch {
            Write-Host ""
            if ($attempt -lt 3) {
                Write-Host "   !!  Download attempt $attempt failed: $_" -ForegroundColor Yellow
                Write-Host "   >>  Retrying download..." -ForegroundColor Cyan
                Start-Sleep -Seconds (2 * $attempt)
            } else {
                throw "Download failed after $attempt attempts: $_"
            }
        } finally {
            if ($out) { $out.Close() }
            if ($stream) { $stream.Close() }
            if ($resp) { $resp.Close() }
        }

        if (Test-Path $DestPath) { Remove-Item $DestPath -Force -ErrorAction SilentlyContinue }
    }
}

function Install-LlamaArchive {
    param([string]$Variant, [string]$AssetName)

    $dest = Join-Path $llmRoot $Variant
    $server = Join-Path $dest "llama-server.exe"
    if (Test-Path $server) {
        Write-Host "   OK  llama.cpp $Variant backend already ready."
        return
    }

    $archive = Join-Path $toolsDir $AssetName
    $extract = Join-Path $toolsDir "llama-$Variant-extract"
    $url = "https://github.com/ggml-org/llama.cpp/releases/download/$Release/$AssetName"

    New-Item -ItemType Directory -Force -Path $toolsDir, $dest | Out-Null
    Remove-Item $archive, $extract -Recurse -Force -ErrorAction SilentlyContinue

    Download-File -Url $url -DestPath $archive -Label "llama.cpp $Variant backend ($Release)"

    Write-Host "   >>  Extracting llama.cpp $Variant backend..."
    Expand-Archive -Path $archive -DestinationPath $extract -Force

    Get-ChildItem $extract -Recurse -File | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $dest $_.Name) -Force
    }
    Remove-Item $archive, $extract -Recurse -Force -ErrorAction SilentlyContinue

    if ($Variant -eq "cuda") {
        $cudartAsset = "cudart-llama-bin-win-cuda-12.4-x64.zip"
        $cudartArchive = Join-Path $toolsDir $cudartAsset
        $cudartExtract = Join-Path $toolsDir "llama-cudart-extract"
        $cudartUrl = "https://github.com/ggml-org/llama.cpp/releases/download/$Release/$cudartAsset"

        Remove-Item $cudartArchive, $cudartExtract -Recurse -Force -ErrorAction SilentlyContinue

        Download-File -Url $cudartUrl -DestPath $cudartArchive -Label "llama.cpp CUDA runtime library ($Release)"

        Write-Host "   >>  Extracting CUDA runtime libraries..."
        Expand-Archive -Path $cudartArchive -DestinationPath $cudartExtract -Force

        Get-ChildItem $cudartExtract -Recurse -File | ForEach-Object {
            Copy-Item $_.FullName (Join-Path $dest $_.Name) -Force
        }
        Remove-Item $cudartArchive, $cudartExtract -Recurse -Force -ErrorAction SilentlyContinue
    }

    if (-not (Test-Path $server)) {
        throw "llama-server.exe was not found after extracting $AssetName"
    }
    Write-Host "   OK  llama.cpp $Variant backend installed."
}

function Try-InstallLlamaArchive {
    param([string]$Variant, [string]$AssetName, [string]$Reason)

    try {
        Install-LlamaArchive -Variant $Variant -AssetName $AssetName
    } catch {
        Write-Host "   !!  Skipping optional llama.cpp $Variant backend: $Reason" -ForegroundColor Yellow
        Write-Host "       $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}

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

if ($hasNvidia) {
    Try-InstallLlamaArchive -Variant "cuda" -AssetName "llama-$Release-bin-win-cuda-12.4-x64.zip" -Reason "NVIDIA CUDA acceleration"
}

$hasAmd = $false
try {
    $gpus = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
    foreach ($gpu in $gpus) {
        if ($gpu.Name -like "*AMD*" -or $gpu.Name -like "*Radeon*") {
            $hasAmd = $true
        }
    }
} catch {}
if ($hasAmd) {
    Try-InstallLlamaArchive -Variant "hip" -AssetName "llama-$Release-bin-win-hip-x64.zip" -Reason "AMD HIP acceleration"
}
# Intel Arc/Graphics detection for SYCL backend
$hasIntel = $false
try {
    $gpus = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
    foreach ($gpu in $gpus) {
        if ($gpu.Name -like "*Intel*") {
            $hasIntel = $true
        }
    }
} catch {}
if ($hasIntel) {
    Try-InstallLlamaArchive -Variant "sycl" -AssetName "llama-$Release-bin-win-sycl-x64.zip" -Reason "Intel SYCL acceleration"
}
Install-LlamaArchive -Variant "vulkan" -AssetName "llama-$Release-bin-win-vulkan-x64.zip"
Install-LlamaArchive -Variant "cpu" -AssetName "llama-$Release-bin-win-cpu-x64.zip"
