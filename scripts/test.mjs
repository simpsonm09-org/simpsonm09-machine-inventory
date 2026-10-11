#!/usr/bin/env node
// Test runner. Runs the real validation, the render check, and the schema and
// non-identifying fixtures. One line per case; exits nonzero on any failure.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  duplicateIdErrors,
  loadMachines,
  nonIdentifyingErrors,
  renderTable,
  validateRecord,
  vramTierForGib,
} from './lib/inventory.mjs';
import { MACHINES_END, MACHINES_START, renderReadme } from './render.mjs';

const DIR = 'machines';
let failed = 0;

function check(name, fn) {
  try {
    fn();
    process.stdout.write(`ok   ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`FAIL ${name}: ${error.message}\n`);
  }
}

function allErrors(record) {
  return [...validateRecord(record), ...nonIdentifyingErrors(record)];
}

const base = {
  id: 'example-node',
  role: 'workstation',
  storageClass: 'storage-ample',
  os: { windows: 'Windows 11 24H2' },
  cpu: { cores: 8, threads: 16 },
  ramTier: '64-127',
  gpu: 'discrete',
  disks: { nvme: 1, hdd: 1 },
  capabilities: { docker: true, wsl: true, gpuCompute: true, alwaysOn: false },
  notes: 'Primary Windows workstation.',
};

const localInference = {
  runtime: 'llama.cpp',
  version: 'b11529',
  cudaVersion: '12.4',
  modelFamily: 'Qwen3.5-9B',
  quantization: 'UD-Q4_K_XL',
  vramGb: 16,
  port: 1234,
  harness: 'Pi',
  providerId: 'llama-local',
};

check('valid record passes', () => {
  assert.deepEqual(allErrors(base), []);
});

check('a hostname key is rejected', () => {
  const errors = nonIdentifyingErrors({ ...base, hostname: 'example' });
  assert.ok(
    errors.some((message) => /hostname/.test(message)),
    'expected a hostname error',
  );
});

check('a note with a drive path is rejected', () => {
  const errors = nonIdentifyingErrors({ ...base, notes: 'lives at C:\\Users\\person' });
  assert.ok(errors.length > 0, 'expected a non-identifying error');
});

check('an unknown role is rejected', () => {
  assert.ok(
    validateRecord({ ...base, role: 'toaster' }).some((message) => /role/.test(message)),
    'expected a role error',
  );
});

check('a record missing cpu is rejected once', () => {
  const rest = { ...base };
  delete rest.cpu;
  assert.deepEqual(
    validateRecord(rest),
    ['missing required field "cpu"'],
    'expected exactly one missing cpu error',
  );
});

check('an unknown disk class key is rejected', () => {
  const errors = validateRecord({ ...base, disks: { nvme: 1, Samsung_990_PRO_2TB: 1 } });
  assert.ok(
    errors.some((message) => /disks/.test(message)),
    'expected a disk class error',
  );
});

check('an extra cpu key is rejected', () => {
  const errors = validateRecord({ ...base, cpu: { cores: 8, threads: 16, model: 'Ryzen' } });
  assert.ok(
    errors.some((message) => /cpu/.test(message)),
    'expected a cpu key error',
  );
});

check('a hyphen-separated MAC is rejected', () => {
  const errors = nonIdentifyingErrors({ ...base, notes: 'nic aa-bb-cc-dd-ee-ff' });
  assert.ok(
    errors.some((message) => /MAC/.test(message)),
    'expected a MAC error',
  );
});

check('an extra capabilities key is rejected', () => {
  const errors = validateRecord({ ...base, capabilities: { ...base.capabilities, secret: true } });
  assert.ok(
    errors.some((message) => /capabilities/.test(message)),
    'expected a capabilities key error',
  );
});

check('an unknown top-level key is rejected by name', () => {
  const errors = validateRecord({ ...base, mystery: true });
  assert.ok(errors.some((message) => message.includes('mystery')), 'expected the unknown key name');
});

check('a local inference capability passes', () => {
  assert.deepEqual(validateRecord({ ...base, capabilities: { ...base.capabilities, localInference } }), []);
});

check('a local inference port must be an integer TCP port', () => {
  for (const port of [0, 65536, 1234.5, '1234']) {
    const errors = validateRecord({
      ...base,
      capabilities: { ...base.capabilities, localInference: { ...localInference, port } },
    });
    assert.ok(errors.some((message) => /port/.test(message)), `expected ${port} to be rejected`);
  }
  for (const port of [1, 65535]) {
    const errors = validateRecord({
      ...base,
      capabilities: { ...base.capabilities, localInference: { ...localInference, port } },
    });
    assert.ok(!errors.some((message) => /port/.test(message)), `expected ${port} to pass`);
  }
});

check('local inference requires all declared fields and rejects unknown keys', () => {
  for (const key of Object.keys(localInference)) {
    const missing = { ...localInference };
    delete missing[key];
    const missingErrors = validateRecord({
      ...base,
      capabilities: { ...base.capabilities, localInference: missing },
    });
    assert.ok(missingErrors.some((message) => message.includes(`.${key} is required`)), `expected ${key} requirement`);
  }
  const unknownErrors = validateRecord({
    ...base,
    capabilities: {
      ...base.capabilities,
      localInference: { ...localInference, extra: true },
    },
  });
  assert.ok(unknownErrors.some((message) => /extra/.test(message)), 'expected unknown local inference key');
});

check('local inference VRAM and text fields must be valid', () => {
  for (const vramGb of [0, -1, 16.5, '16']) {
    const errors = validateRecord({
      ...base,
      capabilities: { ...base.capabilities, localInference: { ...localInference, vramGb } },
    });
    assert.ok(errors.some((message) => /vramGb/.test(message)), `expected ${vramGb} to be rejected`);
  }
  const errors = validateRecord({
    ...base,
    capabilities: { ...base.capabilities, localInference: { ...localInference, runtime: '' } },
  });
  assert.ok(errors.some((message) => /runtime/.test(message)), 'expected empty runtime to be rejected');
});

check('a vendor and a VRAM tier on a discrete GPU pass', () => {
  assert.deepEqual(allErrors({ ...base, gpuVendor: 'nvidia', vramTier: '16-23' }), []);
});

check('a vramTier outside the tier list is rejected', () => {
  assert.ok(
    validateRecord({ ...base, vramTier: '16' }).some((message) => /vramTier/.test(message)),
    'expected a vramTier error',
  );
});

check('a gpuVendor outside the vendor list is rejected', () => {
  assert.ok(
    validateRecord({ ...base, gpuVendor: 'Acme' }).some((message) => /gpuVendor/.test(message)),
    'expected a gpuVendor error',
  );
});

check('a VRAM field on a non-discrete GPU is rejected', () => {
  const integrated = { ...base, gpu: 'integrated', vramTier: '16-23' };
  assert.ok(
    validateRecord(integrated).some((message) => /vramTier/.test(message)),
    'expected a vramTier error',
  );
});

check('VRAM buckets split at 8, 12, 16, 24, and 48 GiB', () => {
  const expected = [
    [7, '<8'],
    [8, '8-11'],
    [11, '8-11'],
    [12, '12-15'],
    [15, '12-15'],
    [16, '16-23'],
    [23, '16-23'],
    [24, '24-47'],
    [47, '24-47'],
    [48, '48+'],
  ];
  for (const [gib, tier] of expected) {
    assert.equal(vramTierForGib(gib), tier, `${gib} GiB`);
  }
});

check('every whole-GiB VRAM size maps to an allowed vramTier', () => {
  for (let gib = 0; gib <= 96; gib += 1) {
    assert.deepEqual(validateRecord({ ...base, vramTier: vramTierForGib(gib) }), [], `${gib} GiB`);
  }
});

check('the RAM bucket values are rejected as a vramTier', () => {
  for (const tier of ['<16', '16-31', '32-63', '64-127', '128+']) {
    assert.ok(
      validateRecord({ ...base, vramTier: tier }).some((message) => /vramTier/.test(message)),
      `expected ${tier} to be rejected`,
    );
  }
});

check('a serial or hostname in a GPU field is rejected', () => {
  for (const value of ['SN-0000000001', 'example-host']) {
    assert.ok(allErrors({ ...base, gpuVendor: value }).length > 0, `expected ${value} to be rejected`);
  }
});

check('a drive path in a VRAM field is rejected', () => {
  assert.ok(allErrors({ ...base, vramTier: 'C:\\Users\\example' }).length > 0, 'expected a path error');
});

check('duplicate machine ids are rejected', () => {
  const machines = [
    { name: 'a.json', record: { ...base, id: 'same-id' } },
    { name: 'b.json', record: { ...base, id: 'same-id' } },
  ];
  assert.ok(
    duplicateIdErrors(machines).length > 0,
    'expected a duplicate id error',
  );
});

check('a value with a newline stays on one table row', () => {
  const record = { ...base, os: { windows: 'Windows\n11' } };
  const body = renderTable([{ record }]).split('\n').slice(2);
  assert.equal(body.length, 1, 'expected exactly one table body row');
});

check('an undeclared inference capability renders as none', () => {
  const table = renderTable([{ record: base }]);
  assert.ok(table.includes('| none |'), 'expected a plain empty capability label');
});

check('local inference details appear in the rendered table', () => {
  const record = { ...base, capabilities: { ...base.capabilities, localInference } };
  const table = renderTable([{ record }]);
  for (const value of ['llama.cpp', 'b11529', '12.4', 'Qwen3.5-9B', 'UD-Q4_K_XL', '16 GB VRAM', '1234', 'Pi', 'llama-local']) {
    assert.ok(table.includes(value), `expected ${value} in table`);
  }
});

check('real machine records validate', () => {
  const machines = loadMachines(DIR);
  assert.ok(machines.length > 0, 'expected at least one machine record');
  for (const { name, record } of machines) {
    assert.deepEqual(allErrors(record), [], `${name} is invalid`);
  }
  assert.deepEqual(duplicateIdErrors(machines), [], 'duplicate machine ids');
});

check('desktop-primary records the GPU vendor and VRAM tier', () => {
  const { record } = loadMachines(DIR).find((machine) => machine.record.id === 'desktop-primary');
  assert.equal(record.gpuVendor, 'nvidia');
  assert.equal(record.vramTier, '16-23');
});

check('README machine table is current', () => {
  const readme = readFileSync('README.md', 'utf8');
  assert.ok(readme.includes(MACHINES_START) && readme.includes(MACHINES_END), 'README markers are missing');
  const next = renderReadme(readme, renderTable(loadMachines(DIR)));
  assert.ok(readme === next, 'README machine table is stale, run "just render"');
});

if (failed > 0) {
  process.stdout.write(`test: ${failed} case(s) failed\n`);
  process.exit(1);
}
process.stdout.write('test: ok\n');
process.exit(0);
