# machine-inventory working agreements

The public machine-class inventory for the `simpsonm09-org` fleet. It holds
hardware classes, counts, and buckets, never an identifying value.

## Ground rules

- No hostname, username, machine serial, drive path, IP, or MAC is committed.
- No secret, credential, or machine path is committed.
- A record holds classes, counts, and buckets. Never write an exact disk model
  or an exact disk size.
- A value the collector cannot detect degrades to a safe empty value where the
  schema allows it. For the OS and the disk set it refuses and exits 2 rather
  than write an invalid record. Never guess a value.
- Regenerate the README table with `just render` after a record change. Do not
  hand-edit the table between the machines markers.

## Commands

- `just install`, `just collect`, `just render`, `just render-check`, `just test`, `just verify`.
- Collect a record on Windows: `pwsh -File scripts/collect.ps1 -Id <id> -Role workstation -Write`.
- Collect a record on Linux or WSL: `bash scripts/collect.sh --id <id> --role workstation --write`.

## Repo facts

- Language and toolchain: Node for the validator, renderer, and tests, and
  PowerShell and bash for the collectors, pinned in `mise.toml`.
- Schema: the record schema and the non-identifying rules are in
  [`docs/schema.md`](docs/schema.md) and enforced by `scripts/lib/inventory.mjs`.
- Data: `machines/<id>.json` is one machine record. `docs/manifest.json` lists
  the documentation artifacts and `docs/architecture.md` carries the diagram.
- Domain: the storage classes are `storage-ample` and `storage-constrained`.
  The rule is the free space on the fast disk: 40 GB or more is ample.

## Skills

No repo-local skills. General best practices and integration come from the plugins.
