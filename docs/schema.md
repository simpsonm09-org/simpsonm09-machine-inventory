# Schema

A machine file is one JSON object at `machines/<id>.json`. The validator in
`scripts/lib/inventory.mjs` enforces this shape. The validator, the renderer,
and the tests share that one module so they agree.

## Object

| Field | Type | Rule |
| --- | --- | --- |
| `id` | string | Matches `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`. |
| `role` | string | One of `workstation`, `server`, `runner`. |
| `storageClass` | string | One of `storage-ample`, `storage-constrained`. |
| `os` | object | Keys limited to `windows`, `linux`, `wsl`, `macos`, with non-empty string values. |
| `cpu` | object | Exactly `cores` and `threads`, each a non-negative integer. No other key is allowed. |
| `ramTier` | string | One of `<16`, `16-31`, `32-63`, `64-127`, `128+`. Boundaries: below 16 GiB, 16-31 GiB, 32-63 GiB, 64-127 GiB, and 128 GiB or more. Total physical memory is rounded to the nearest whole GiB before bucketing. |
| `gpu` | string | One of `none`, `integrated`, `discrete`. |
| `gpuVendor` | string | Optional. One of `nvidia`, `amd`, `intel`. Allowed only when `gpu` is `discrete`, and omitted when the vendor cannot be read. |
| `vramTier` | string | Optional. One of the `ramTier` buckets, `<16`, `16-31`, `32-63`, `64-127`, `128+`, applied to dedicated video memory. Allowed only when `gpu` is `discrete`. The memory is rounded to the nearest whole GiB before bucketing, and it is omitted when it cannot be read, never guessed. Shared or unified memory is not dedicated and is never reported. |
| `disks` | object | Integer counts keyed by disk class: `nvme`, `ssd`, `hdd`, `usb`, or `other`, for example `{ "nvme": 1, "hdd": 1 }`. A `USB` bus disk is classed `usb`. At least one key. No sizes. Any other key, such as an exact disk model, is rejected. |
| `capabilities` | object | All four booleans: `docker`, `wsl`, `gpuCompute`, `alwaysOn`. Exactly these four keys; no other key is allowed. `docker` is true when the machine can run the local container stack: the Windows `docker` CLI exists, or, when a WSL distro is present, `wsl.exe --exec docker --version` exits 0. |
| `notes` | string | Optional. Non-identifying. |

Required: `id`, `role`, `storageClass`, `os`, `cpu`, `ramTier`, `gpu`, `disks`,
and `capabilities`.

## Example

```json
{
  "id": "desktop-primary",
  "role": "workstation",
  "storageClass": "storage-ample",
  "os": { "windows": "Windows 11 24H2" },
  "cpu": { "cores": 8, "threads": 16 },
  "ramTier": "64-127",
  "gpu": "discrete",
  "gpuVendor": "nvidia",
  "vramTier": "16-31",
  "disks": { "nvme": 1, "hdd": 1 },
  "capabilities": { "docker": true, "wsl": true, "gpuCompute": true, "alwaysOn": false },
  "notes": "Primary Windows workstation."
}
```

## Non-identifying rules

A record is refused anywhere in the object, at any depth, when it holds:

- A key whose normalized name is one of `hostname`, `computername`, `host`,
  `user`, `username`, `serial`, `serialnumber`, `uuid`, `biouuid`, `mac`, `ip`,
  `ipaddress`, or `machineid`.
- A string value that matches a drive path `[A-Za-z]:[\\/]`, a home path
  segment `(^|[\\/])(Users|home)[\\/]`, a literal backslash, an email address,
  an IPv4 address, or a MAC address. A MAC address is matched with either a
  colon or a hyphen separator, as in `aa:bb:cc:dd:ee:ff` or
  `aa-bb-cc-dd-ee-ff`.

The rules exist so the public repository never discloses a machine identity.
When a value cannot be detected, the collector degrades to a safe empty value
where the schema allows it. For `os` and `disks` it refuses and exits 2 rather
than write an invalid record. It never guesses a value.
