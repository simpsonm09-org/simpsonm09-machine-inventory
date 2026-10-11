# Collect

A collector reads the local machine and emits one record. It reads classes,
counts, and buckets only, and it never reads the hostname, the username, a
serial number, or a drive path.

## Windows

```powershell
pwsh -File scripts/collect.ps1 -Id desktop-primary -Role workstation -Write
```

Without `-Write` the collector prints the JSON to stdout. With `-Write` it
writes `machines/<id>.json`.

Parameters:

| Parameter | Default | Does |
| --- | --- | --- |
| `-Id` | `$env:SIMPSONM09_MACHINE_ID` | The record id. Required. |
| `-Role` | `workstation` | `workstation`, `server`, or `runner`. |
| `-StorageClass` | `$env:SIMPSONM09_MACHINE_PROFILE` | `storage-ample` or `storage-constrained`. |
| `-Gpu` | detected | `none`, `integrated`, or `discrete`. |
| `-AlwaysOn` | off | Marks the machine as always on. |
| `-Notes` | none | A short non-identifying note. |
| `-Write` | off | Writes the record instead of printing it. |
| `-OutDir` | `machines` | The output directory. |

The collector refuses to run without an `-Id`. It detects CPU cores and threads
from `Win32_Processor`, the RAM tier from `Win32_ComputerSystem` with total
physical memory rounded to the nearest whole GiB, the GPU class from
`Win32_VideoController`, disk counts by class from `Get-PhysicalDisk`, and
the OS from `Win32_OperatingSystem` plus the `DisplayVersion` registry value.
For a discrete GPU it reads `gpuVendor` and `vramTier` from `nvidia-smi --query-gpu=memory.total`
(the first GPU, in MiB) when `nvidia-smi` is present. Without it, it falls back to the
`Win32_VideoController` vendor name and `AdapterRAM`. `AdapterRAM` is a 32-bit field that caps at
4 GiB, so the collector leaves `vramTier` out when the value is at or near the cap. It never reads
the GPU product name.

The collector does not detect `capabilities.localInference`, so `-Write` replaces the record without it. Re-add the declaration by hand after a re-collect, and keep the rest of the record as the collector wrote it.
Disk classes are `nvme`, `ssd`, `hdd`, `usb`, and `other`; a disk on the `USB`
bus is classed `usb`, so an external drive is not reported as an internal one.
The OS string drops the edition word (`Home`, `Pro`, `Professional`,
`Enterprise`, `Education`, `IoT`, or `LTSC`) so it reads `Windows 11 24H2`. It
sets `capabilities.docker` true when the machine can run the local container
stack: the Windows `docker` CLI exists, or, when a WSL distro is present,
`wsl.exe --exec docker --version` exits 0.
If `Get-PhysicalDisk` throws, or the OS cannot be read, the collector prints a
`collect:` error and exits 2 instead of writing an invalid record.

## Linux and WSL

```bash
bash scripts/collect.sh --id wsl-ubuntu --role workstation --write
```

It reads the OS from `/etc/os-release`, the CPU from `lscpu` or `nproc`, the RAM
tier from `/proc/meminfo` with total memory rounded to the nearest whole GiB,
the GPU class from `/dev/dxg` and `nvidia-smi`, and disk counts by class from
`lsblk -d -o NAME,ROTA`. For a discrete GPU it reads `gpuVendor` and `vramTier` from
`nvidia-smi --query-gpu=memory.total` only, and it omits both when `nvidia-smi` is silent.
Inside WSL these block devices are virtual. It reads no
sizes. It sets `capabilities.docker` true when the `docker` CLI is on `PATH`.

The storage class comes from `--storage-class` or `SIMPSONM09_MACHINE_PROFILE`,
falling back to the free space on the current filesystem.

## Add a machine

1. Run a collector against the machine and write the record.
2. Edit the record so the `notes` string is short and non-identifying.
3. Run `just render` to refresh the README table.
4. Run `just verify`. It validates every record, checks the README is current,
   and runs the fixtures.

## Storage class

The storage classes are `storage-ample` and `storage-constrained`. The rule is
the free space on the fast disk, which is C: on Windows: 40 GB or more is
`storage-ample`, otherwise `storage-constrained`.
