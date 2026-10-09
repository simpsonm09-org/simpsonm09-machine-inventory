# platforms: windows
[CmdletBinding()]
param(
    [string] $Id = $env:SIMPSONM09_MACHINE_ID,
    [string] $Role = 'workstation',
    [string] $StorageClass = $env:SIMPSONM09_MACHINE_PROFILE,
    [string] $Gpu,
    [switch] $AlwaysOn,
    [string] $Notes,
    [switch] $Write,
    [string] $OutDir = 'machines'
)

# Collects one machine record as JSON, using classes, counts, and buckets only.
# It never reads the hostname, the username, a serial number, or a drive path.

$ROLES = @('workstation', 'server', 'runner')
$STORAGE_CLASSES = @('storage-ample', 'storage-constrained')
$GPU_CLASSES = @('none', 'integrated', 'discrete')
$ID_PATTERN = '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
$AMPLE_FREE_GB = 40

if ([string]::IsNullOrWhiteSpace($Id)) {
    [Console]::Error.WriteLine('collect: -Id is required (pass -Id or set SIMPSONM09_MACHINE_ID)')
    exit 2
}
if ($Id -notmatch $ID_PATTERN) {
    [Console]::Error.WriteLine("collect: -Id must match $ID_PATTERN")
    exit 2
}
if ($ROLES -notcontains $Role) {
    [Console]::Error.WriteLine("collect: -Role must be one of $($ROLES -join ', ')")
    exit 2
}
if (-not [string]::IsNullOrWhiteSpace($Gpu) -and $GPU_CLASSES -notcontains $Gpu) {
    [Console]::Error.WriteLine("collect: -Gpu must be one of $($GPU_CLASSES -join ', ')")
    exit 2
}

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Cpu {
    try {
        $cores = 0
        $threads = 0
        foreach ($processor in Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop) {
            if ($processor.NumberOfCores) { $cores += [int] $processor.NumberOfCores }
            if ($processor.NumberOfLogicalProcessors) { $threads += [int] $processor.NumberOfLogicalProcessors }
        }
        return [ordered]@{ cores = $cores; threads = $threads }
    } catch {
        return [ordered]@{ cores = 0; threads = 0 }
    }
}

function Get-VramBucket {
    param([double] $Gb)
    $whole = [math]::Round($Gb)
    if ($whole -lt 8) { return '<8' }
    if ($whole -lt 12) { return '8-11' }
    if ($whole -lt 16) { return '12-15' }
    if ($whole -lt 24) { return '16-23' }
    if ($whole -lt 48) { return '24-47' }
    return '48+'
}

function Get-RamTier {
    try {
        $bytes = [double] (Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop).TotalPhysicalMemory
    } catch {
        return '<16'
    }
    $gb = [math]::Round($bytes / 1GB)
    if ($gb -lt 16) { return '<16' }
    if ($gb -lt 32) { return '16-31' }
    if ($gb -lt 64) { return '32-63' }
    if ($gb -lt 128) { return '64-127' }
    return '128+'
}

function Get-VendorName {
    param([string] $Name)
    if ($Name -match '(?i)nvidia|geforce|rtx|gtx|quadro') { return 'nvidia' }
    if ($Name -match '(?i)radeon rx|radeon pro') { return 'amd' }
    if ($Name -match '(?i)\barc a|\barc b') { return 'intel' }
    return $null
}

function Get-GpuClass {
    $names = @()
    try {
        $names = @(Get-CimInstance -ClassName Win32_VideoController -ErrorAction Stop | ForEach-Object { "$($_.Name)" })
    } catch {
        return 'none'
    }
    $physical = @($names | Where-Object { $_ -and $_ -notmatch '(?i)microsoft basic|remote display|virtual|indirect' })
    if ($physical.Count -eq 0) { return 'none' }
    $joined = $physical -join ' '
    if ($null -ne (Get-VendorName -Name $joined)) { return 'discrete' }
    if ($joined -match '(?i)intel|iris|uhd|hd graphics|vega|radeon graphics|qualcomm|adreno') { return 'integrated' }
    return 'integrated'
}

# Returns the dedicated memory of the first NVIDIA GPU in MiB, or $null when nvidia-smi is absent or silent.
function Get-NvidiaMemoryMiB {
    if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) { return $null }
    try {
        $lines = @(& nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>$null)
    } catch {
        return $null
    }
    if ($LASTEXITCODE -ne 0) { return $null }
    foreach ($line in $lines) {
        $text = "$line".Trim()
        if ($text -match '^\d+$') { return [double] $text }
    }
    return $null
}

# The vendor and VRAM tier of a discrete GPU. nvidia-smi is read first. Win32_VideoController is the fallback.
# A field that cannot be read is left out, never guessed.
function Get-DiscreteGpu {
    $facts = [ordered]@{}
    $mib = Get-NvidiaMemoryMiB
    if ($null -ne $mib) {
        $facts['gpuVendor'] = 'nvidia'
        $facts['vramTier'] = Get-VramBucket -Gb ($mib / 1024)
        return ,$facts
    }
    try {
        $adapters = @(Get-CimInstance -ClassName Win32_VideoController -ErrorAction Stop | Where-Object { $null -ne (Get-VendorName -Name "$($_.Name)") })
    } catch {
        return ,$facts
    }
    if ($adapters.Count -eq 0) { return ,$facts }
    $vendor = Get-VendorName -Name "$($adapters[0].Name)"
    if ($vendor) { $facts['gpuVendor'] = $vendor }
    # AdapterRAM is a 32-bit field, so a card of 4 GiB or more reads as 4 GiB. Leave the tier out in that case.
    $largest = 0.0
    foreach ($adapter in $adapters) {
        $bytes = [double] $adapter.AdapterRAM
        if ($bytes -le 0 -or $bytes -ge (4GB - 1MB)) { return ,$facts }
        $largest = [math]::Max($largest, $bytes)
    }
    $facts['vramTier'] = Get-VramBucket -Gb ($largest / 1GB)
    return ,$facts
}

function Get-DiskCounts {
    $counts = @{}
    try {
        $disks = @(Get-PhysicalDisk -ErrorAction Stop)
    } catch {
        return $counts
    }
    foreach ($disk in $disks) {
        $media = "$($disk.MediaType)"
        $bus = "$($disk.BusType)"
        $class = 'other'
        if ($bus -eq 'USB') { $class = 'usb' }
        elseif ($media -eq 'HDD') { $class = 'hdd' }
        elseif ($media -eq 'SSD' -and $bus -eq 'NVMe') { $class = 'nvme' }
        elseif ($media -eq 'SSD') { $class = 'ssd' }
        elseif ($bus -eq 'NVMe') { $class = 'nvme' }
        if (-not $counts.ContainsKey($class)) { $counts[$class] = 0 }
        $counts[$class] = $counts[$class] + 1
    }
    return $counts
}

function Get-OsInfo {
    $os = [ordered]@{}
    try {
        $caption = "$((Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).Caption)"
        $display = "$((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name DisplayVersion -ErrorAction SilentlyContinue).DisplayVersion)"
        $value = ($caption -replace '^Microsoft\s+', '').Trim()
        # Drop the edition word so the product and the display version remain.
        $value = ($value -replace '\s*\b(?:Home|Pro|Professional|Enterprise|Education|IoT|LTSC)\b\s*', ' ').Trim()
        if (-not [string]::IsNullOrWhiteSpace($display) -and $display -ne '') { $value = "$value $display".Trim() }
        if (-not [string]::IsNullOrWhiteSpace($value)) { $os['windows'] = $value }
    } catch {
        # Leave the windows key out when the OS cannot be read.
    }
    return $os, (Get-WslName)
}

function Get-WslName {
    try {
        $lines = & wsl.exe --list --verbose 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $lines) { return $null }
        $text = ((@($lines) | ForEach-Object { "$_" }) -join "`n") -replace "`0", ''
        $distro = $null
        foreach ($line in ($text -split "`r?`n")) {
            if ($line -match '^\s*\*?\s*([A-Za-z0-9._-]+)\s+\S+\s+\d+\s*$') {
                $distro = $matches[1]
                break
            }
        }
        if (-not $distro) { return $null }
        $label = $distro
        try {
            $release = & wsl.exe -d $distro cat /etc/os-release 2>$null
            if ($LASTEXITCODE -eq 0 -and $release) {
                foreach ($line in ((@($release) | ForEach-Object { "$_" }) -join "`n") -split "`r?`n") {
                    if ($line -match '^PRETTY_NAME="?([^"]+?)"?\s*$') { $label = $matches[1].Trim(); break }
                }
            }
        } catch {
            # Keep the distro name when /etc/os-release cannot be read.
        }
        return $label
    } catch {
        return $null
    }
}

function Test-DockerCapability {
    param([bool] $WslPresent)
    try {
        if (Get-Command docker -ErrorAction SilentlyContinue) { return $true }
    } catch {
        # Fall through to the WSL probe.
    }
    if (-not $WslPresent) { return $false }
    try {
        $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = 'wsl.exe'
        $startInfo.Arguments = '--exec docker --version'
        $startInfo.UseShellExecute = $false
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.CreateNoWindow = $true
        $probe = [System.Diagnostics.Process]::Start($startInfo)
        if (-not $probe.WaitForExit(5000)) {
            try { $probe.Kill() } catch { }
            return $false
        }
        return ($probe.ExitCode -eq 0)
    } catch {
        return $false
    }
}

function Get-StorageClass {
    param([string] $Override)
    if (-not [string]::IsNullOrWhiteSpace($Override)) {
        if ($STORAGE_CLASSES -notcontains $Override) {
            [Console]::Error.WriteLine("collect: storage class must be one of $($STORAGE_CLASSES -join ', ')")
            exit 2
        }
        return $Override
    }
    try {
        $freeGb = [math]::Round((Get-PSDrive -Name C -ErrorAction Stop).Free / 1GB, 0)
        if ($freeGb -ge $AMPLE_FREE_GB) { return 'storage-ample' }
        return 'storage-constrained'
    } catch {
        return 'storage-constrained'
    }
}

$os = [ordered]@{}
$wslName = $null
try {
    $osInfo = Get-OsInfo
    $os = $osInfo[0]
    $wslName = $osInfo[1]
} catch {
    $os = [ordered]@{}
}
if ($wslName) { $os['wsl'] = $wslName }

$gpuClass = if ($Gpu) { $Gpu } else { Get-GpuClass }
$gpuFacts = if ($gpuClass -eq 'discrete') { Get-DiscreteGpu } else { [ordered]@{} }
$hasDocker = $false
try { $hasDocker = Test-DockerCapability -WslPresent ([bool] $wslName) } catch { $hasDocker = $false }

$disks = Get-DiskCounts
if ($os.Count -eq 0) {
    [Console]::Error.WriteLine('collect: OS detection returned nothing; refusing to emit an invalid record')
    exit 2
}
if ($disks.Count -eq 0) {
    [Console]::Error.WriteLine('collect: no block devices detected; refusing to emit an invalid record')
    exit 2
}

$record = [ordered]@{
    id           = $Id
    role         = $Role
    storageClass = (Get-StorageClass -Override $StorageClass)
    os           = $os
    cpu          = (Get-Cpu)
    ramTier      = (Get-RamTier)
    gpu          = $gpuClass
}
foreach ($key in @('gpuVendor', 'vramTier')) {
    if ($gpuFacts.Contains($key)) { $record[$key] = $gpuFacts[$key] }
}
$record['disks'] = $disks
$record['capabilities'] = [ordered]@{
    docker     = $hasDocker
    wsl        = ($os.Keys -contains 'wsl')
    gpuCompute = ($gpuClass -ne 'none')
    alwaysOn   = [bool] $AlwaysOn
}
if (-not [string]::IsNullOrWhiteSpace($Notes)) { $record['notes'] = $Notes }

$json = $record | ConvertTo-Json -Depth 8

if ($Write) {
    if (-not (Test-Path -Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
    $path = Join-Path -Path $OutDir -ChildPath "$Id.json"
    [System.IO.File]::WriteAllText($path, "$json`n")
    Write-Output "collect: wrote $path"
} else {
    Write-Output $json
}
