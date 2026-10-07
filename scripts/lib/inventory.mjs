// Shared inventory logic. The schema, the non-identifying rules, and the README
// table live here so the validator, the renderer, and the tests agree.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ENUMS = Object.freeze({
  role: Object.freeze(['workstation', 'server', 'runner']),
  storageClass: Object.freeze(['storage-ample', 'storage-constrained']),
  ramTier: Object.freeze(['<16', '16-31', '32-63', '64-127', '128+']),
  gpu: Object.freeze(['none', 'integrated', 'discrete']),
  osKey: Object.freeze(['windows', 'linux', 'wsl', 'macos']),
  capability: Object.freeze(['docker', 'wsl', 'gpuCompute', 'alwaysOn']),
  diskClass: Object.freeze(['nvme', 'ssd', 'hdd', 'usb', 'other']),
});

export const ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const REQUIRED_FIELDS = ['id', 'role', 'storageClass', 'os', 'cpu', 'ramTier', 'gpu', 'disks', 'capabilities'];

// A key whose normalized name matches one of these names an identifying value
// and is refused wherever it appears in the record.
const IDENTITY_KEYS = new Set([
  'hostname',
  'computername',
  'host',
  'user',
  'username',
  'serial',
  'serialnumber',
  'uuid',
  'biouuid',
  'mac',
  'ip',
  'ipaddress',
  'machineid',
]);

const VALUE_RULES = [
  { pattern: /[A-Za-z]:[\\/]/, label: 'a drive path' },
  { pattern: /(^|[\\/])(Users|home)[\\/]/, label: 'a home path' },
  { pattern: /\\/, label: 'a literal backslash' },
  { pattern: /@/, label: 'an email address' },
  { pattern: /\b\d{1,3}(?:\.\d{1,3}){3}\b/, label: 'an IPv4 address' },
  { pattern: /(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i, label: 'a MAC address' },
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}

function normalizeKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function emptyish(value) {
  return typeof value !== 'string' || value.length === 0;
}

function validateOs(os) {
  const errors = [];
  if (!isPlainObject(os)) return ['os must be an object'];
  const keys = Object.keys(os);
  if (keys.length === 0) errors.push('os must name at least one platform');
  for (const key of keys) {
    if (!ENUMS.osKey.includes(key)) errors.push(`os has unknown platform key "${key}"`);
    else if (emptyish(os[key])) errors.push(`os.${key} must be a non-empty string`);
  }
  return errors;
}

function validateCpu(cpu) {
  const errors = [];
  if (!isPlainObject(cpu)) return ['cpu must be an object'];
  for (const key of Object.keys(cpu)) {
    if (!['cores', 'threads'].includes(key)) errors.push(`cpu has unknown key "${key}"`);
  }
  for (const key of ['cores', 'threads']) {
    if (!(key in cpu)) errors.push(`cpu.${key} is required`);
    else if (!isNonNegativeInt(cpu[key])) errors.push(`cpu.${key} must be a non-negative integer`);
  }
  return errors;
}

function validateDisks(disks) {
  const errors = [];
  if (!isPlainObject(disks)) return ['disks must be an object'];
  const keys = Object.keys(disks);
  if (keys.length === 0) errors.push('disks must include at least one class key');
  for (const key of keys) {
    if (!ENUMS.diskClass.includes(key)) errors.push(`disks has unknown class key "${key}"`);
    else if (!isNonNegativeInt(disks[key])) errors.push(`disks.${key} must be a non-negative integer`);
  }
  return errors;
}

function validateCapabilities(capabilities) {
  const errors = [];
  if (!isPlainObject(capabilities)) return ['capabilities must be an object'];
  for (const key of Object.keys(capabilities)) {
    if (!ENUMS.capability.includes(key)) errors.push(`capabilities has unknown key "${key}"`);
  }
  for (const key of ENUMS.capability) {
    if (typeof capabilities[key] !== 'boolean') errors.push(`capabilities.${key} must be a boolean`);
  }
  return errors;
}

// A per-record schema check. Returns the list of problems; empty means valid.
export function validateRecord(record) {
  if (!isPlainObject(record)) return ['record must be a JSON object'];
  const errors = [];
  for (const key of REQUIRED_FIELDS) {
    if (!(key in record)) errors.push(`missing required field "${key}"`);
  }
  if ('id' in record && (typeof record.id !== 'string' || !ID_PATTERN.test(record.id))) {
    errors.push('id must match ^[a-z][a-z0-9]*(-[a-z0-9]+)*$');
  }
  if ('role' in record && !ENUMS.role.includes(record.role)) {
    errors.push(`role must be one of ${ENUMS.role.join(', ')}`);
  }
  if ('storageClass' in record && !ENUMS.storageClass.includes(record.storageClass)) {
    errors.push(`storageClass must be one of ${ENUMS.storageClass.join(', ')}`);
  }
  if ('ramTier' in record && !ENUMS.ramTier.includes(record.ramTier)) {
    errors.push(`ramTier must be one of ${ENUMS.ramTier.join(', ')}`);
  }
  if ('gpu' in record && !ENUMS.gpu.includes(record.gpu)) {
    errors.push(`gpu must be one of ${ENUMS.gpu.join(', ')}`);
  }
  if ('os' in record) errors.push(...validateOs(record.os));
  if ('cpu' in record) errors.push(...validateCpu(record.cpu));
  if ('disks' in record) errors.push(...validateDisks(record.disks));
  if ('capabilities' in record) errors.push(...validateCapabilities(record.capabilities));
  if ('notes' in record && typeof record.notes !== 'string') errors.push('notes must be a string');
  return errors;
}

function walk(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, errors));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (IDENTITY_KEYS.has(normalizeKey(key))) {
        errors.push(`${path}.${key} names an identifying field`);
      }
      walk(child, `${path}.${key}`, errors);
    }
    return;
  }
  if (typeof value !== 'string') return;
  for (const { pattern, label } of VALUE_RULES) {
    if (pattern.test(value)) {
      errors.push(`${path} contains ${label}`);
      return;
    }
  }
}

// The non-identifying check. Returns the list of problems; empty means clean.
export function nonIdentifyingErrors(value) {
  const errors = [];
  walk(value, '$', errors);
  return errors;
}

// Load every machines/*.json record in a directory, sorted by file name.
export function loadMachines(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
    const file = join(dir, name);
    out.push({ file, name, record: JSON.parse(readFileSync(file, 'utf8')) });
  }
  return out;
}

// Cross-record check: every machine id must be unique. Takes the output of
// loadMachines, so the validator, the renderer, and the tests agree.
export function duplicateIdErrors(machines) {
  const errors = [];
  const seen = new Map();
  for (const { name, record } of machines) {
    const id = record?.id;
    if (typeof id !== 'string') continue;
    if (seen.has(id)) errors.push(`${name}: duplicate machine id "${id}" (also in ${seen.get(id)})`);
    else seen.set(id, name);
  }
  return errors;
}

function escapeCell(value) {
  return String(value).replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
}

function osCell(os) {
  return Object.entries(os)
    .map(([key, value]) => `${key} ${value}`)
    .join('; ');
}

function disksCell(disks) {
  return Object.entries(disks)
    .map(([key, value]) => `${key} ${value}`)
    .join(', ');
}

// The Markdown table body for the README, sorted by machine id.
export function renderTable(records) {
  const lines = [
    '| Machine | Role | Storage | OS | CPU | RAM | GPU | Disks | Always on |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const rows = [...records].sort((a, b) => a.record.id.localeCompare(b.record.id));
  for (const { record } of rows) {
    lines.push(
      `| ${escapeCell(record.id)} | ${escapeCell(record.role)} | ${escapeCell(record.storageClass)} | ` +
        `${escapeCell(osCell(record.os))} | ${record.cpu.cores}c/${record.cpu.threads}t | ` +
        `${escapeCell(record.ramTier)} | ${escapeCell(record.gpu)} | ${escapeCell(disksCell(record.disks))} | ` +
        `${record.capabilities.alwaysOn ? 'yes' : 'no'} |`,
    );
  }
  return lines.join('\n');
}
