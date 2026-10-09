# platforms: posix
# Collects one machine record as JSON on Linux or WSL, using classes, counts,
# and buckets only. It never reads the hostname, the user, or a mount path.

set -u

id=""
role="workstation"
storage_class="${SIMPSONM09_MACHINE_PROFILE:-}"
gpu=""
always_on="false"
notes=""
write="false"
out_dir="machines"

usage() {
  echo "usage: collect.sh --id <id> [--role workstation|server|runner] [--storage-class storage-ample|storage-constrained] [--gpu none|integrated|discrete] [--always-on] [--notes text] [--write] [--out-dir machines]" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --id|-id) id="${2:-}"; shift 2 ;;
    --role|-role) role="${2:-}"; shift 2 ;;
    --storage-class) storage_class="${2:-}"; shift 2 ;;
    --gpu) gpu="${2:-}"; shift 2 ;;
    --always-on) always_on="true"; shift ;;
    --notes) notes="${2:-}"; shift 2 ;;
    --write|-write) write="true"; shift ;;
    --out-dir) out_dir="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "collect: unknown option $1" >&2; exit 2 ;;
  esac
done

if [ -z "$id" ]; then
  echo "collect: --id is required (or set SIMPSONM09_MACHINE_ID)" >&2
  exit 2
fi
if ! printf '%s' "$id" | grep -Eq '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'; then
  echo "collect: --id must match ^[a-z][a-z0-9]*(-[a-z0-9]+)*$" >&2
  exit 2
fi
case "$role" in
  workstation|server|runner) ;;
  *) echo "collect: --role must be workstation, server, or runner" >&2; exit 2 ;;
esac
case "$gpu" in
  ""|none|integrated|discrete) ;;
  *) echo "collect: --gpu must be none, integrated, or discrete" >&2; exit 2 ;;
esac
case "$storage_class" in
  ""|storage-ample|storage-constrained) ;;
  *) echo "collect: --storage-class must be storage-ample or storage-constrained" >&2; exit 2 ;;
esac

json_escape() {
  printf '%s' "$1" | tr -d '\\"'
}

is_wsl="false"
if [ -r /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null; then
  is_wsl="true"
fi

pretty=""
if [ -r /etc/os-release ]; then
  pretty=$(sed -n 's/^PRETTY_NAME="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/os-release | head -n 1)
fi
if [ -z "$pretty" ]; then
  pretty=$(uname -s 2>/dev/null || true)
fi
if [ -z "$pretty" ]; then
  echo "collect: OS label is empty and uname -s failed; refusing to emit an invalid record" >&2
  exit 2
fi

threads=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)
cores=""
if command -v lscpu >/dev/null 2>&1; then
  cores=$(lscpu 2>/dev/null | awk -F: '
    /^Core\(s\) per socket/ { v=$2; gsub(/^[ \t]+/, "", v); c=v }
    /^Socket\(s\)/ { v=$2; gsub(/^[ \t]+/, "", v); s=v }
    END { if (c != "" && s != "") print c * s }')
fi
if [ -z "$cores" ]; then
  cores="$threads"
fi

# The VRAM bucket for a whole-GiB size.
vram_bucket_for_gb() {
  if [ "$1" -lt 8 ]; then echo "<8"
  elif [ "$1" -lt 12 ]; then echo "8-11"
  elif [ "$1" -lt 16 ]; then echo "12-15"
  elif [ "$1" -lt 24 ]; then echo "16-23"
  elif [ "$1" -lt 48 ]; then echo "24-47"
  else echo "48+"
  fi
}

ram_kb=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null)
ram_gb=$(( (${ram_kb:-0} + 524288) / 1024 / 1024 ))
if [ "$ram_gb" -lt 16 ]; then ram_tier="<16"
elif [ "$ram_gb" -lt 32 ]; then ram_tier="16-31"
elif [ "$ram_gb" -lt 64 ]; then ram_tier="32-63"
elif [ "$ram_gb" -lt 128 ]; then ram_tier="64-127"
else ram_tier="128+"
fi

gpu_class="$gpu"
if [ -z "$gpu_class" ]; then
  if command -v nvidia-smi >/dev/null 2>&1; then
    gpu_class="discrete"
  elif [ -e /dev/dxg ]; then
    gpu_class="integrated"
  else
    gpu_class="none"
  fi
fi

# The vendor and VRAM tier of a discrete GPU come from nvidia-smi only. A field
# that cannot be read is left out, never guessed.
gpu_vendor=""
vram_tier=""
if [ "$gpu_class" = "discrete" ] && command -v nvidia-smi >/dev/null 2>&1; then
  vram_mib=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -n 1 | tr -d ' \r')
  case "$vram_mib" in
    ""|*[!0-9]*) ;;
    *)
      gpu_vendor="nvidia"
      vram_tier=$(vram_bucket_for_gb $(( (vram_mib + 512) / 1024 )))
      ;;
  esac
fi
gpu_fields=""
if [ -n "$gpu_vendor" ]; then gpu_fields="$gpu_fields  \"gpuVendor\": \"$gpu_vendor\",
"; fi
if [ -n "$vram_tier" ]; then gpu_fields="$gpu_fields  \"vramTier\": \"$(json_escape "$vram_tier")\",
"; fi

if [ -z "$storage_class" ]; then
  free_kb=$(df -Pk . 2>/dev/null | awk 'NR == 2 { print $4 }')
  free_gb=$(( ${free_kb:-0} / 1024 / 1024 ))
  if [ "$free_gb" -ge 40 ]; then storage_class="storage-ample"; else storage_class="storage-constrained"; fi
fi

# lsblk reports the host block devices; inside WSL these are virtual. Counts
# only: NAME classifies, ROTA separates rotating from solid state, and no size
# is read.
nvme=0
ssd=0
hdd=0
other=0
if command -v lsblk >/dev/null 2>&1; then
  while read -r name rota; do
    [ -z "$name" ] && continue
    if [ "$rota" = "1" ]; then
      hdd=$((hdd + 1))
    elif [ "$rota" = "0" ]; then
      ssd=$((ssd + 1))
    else
      other=$((other + 1))
    fi
  done <<EOF
$(lsblk -d -o NAME,ROTA -n 2>/dev/null)
EOF
fi

if [ "$nvme" -eq 0 ] && [ "$ssd" -eq 0 ] && [ "$hdd" -eq 0 ] && [ "$other" -eq 0 ]; then
  echo "collect: no block devices detected; refusing to emit an invalid record" >&2
  exit 2
fi

if [ "$is_wsl" = "true" ]; then
  os_json="{\"wsl\": \"$(json_escape "$pretty")\"}"
else
  os_json="{\"linux\": \"$(json_escape "$pretty")\"}"
fi

disks_json="{"
sep=""
if [ "$nvme" -gt 0 ]; then disks_json="$disks_json\"nvme\": $nvme"; sep=", "; fi
if [ "$ssd" -gt 0 ]; then disks_json="$disks_json$sep\"ssd\": $ssd"; sep=", "; fi
if [ "$hdd" -gt 0 ]; then disks_json="$disks_json$sep\"hdd\": $hdd"; sep=", "; fi
if [ "$other" -gt 0 ]; then disks_json="$disks_json$sep\"other\": $other"; fi
disks_json="$disks_json}"

docker="false"
if command -v docker >/dev/null 2>&1; then docker="true"; fi
gpu_compute="false"
if [ "$gpu_class" != "none" ]; then gpu_compute="true"; fi

json="{
  \"id\": \"$(json_escape "$id")\",
  \"role\": \"$(json_escape "$role")\",
  \"storageClass\": \"$(json_escape "$storage_class")\",
  \"os\": $os_json,
  \"cpu\": { \"cores\": ${cores:-0}, \"threads\": ${threads:-0} },
  \"ramTier\": \"$(json_escape "$ram_tier")\",
  \"gpu\": \"$(json_escape "$gpu_class")\",
$gpu_fields  \"disks\": $disks_json,
  \"capabilities\": { \"docker\": $docker, \"wsl\": $is_wsl, \"gpuCompute\": $gpu_compute, \"alwaysOn\": $always_on }"
if [ -n "$notes" ]; then
  json="$json,
  \"notes\": \"$(json_escape "$notes")\""
fi
json="$json
}"

if [ "$write" = "true" ]; then
  mkdir -p "$out_dir"
  printf '%s\n' "$json" > "$out_dir/$id.json"
  echo "collect: wrote $out_dir/$id.json"
else
  printf '%s\n' "$json"
fi
