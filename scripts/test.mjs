#!/usr/bin/env node
// Test runner. Runs the real validation, the render check, and the schema and
// non-identifying fixtures. One line per case; exits nonzero on any failure.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { duplicateIdErrors, loadMachines, nonIdentifyingErrors, renderTable, validateRecord } from './lib/inventory.mjs';
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

check('real machine records validate', () => {
  const machines = loadMachines(DIR);
  assert.ok(machines.length > 0, 'expected at least one machine record');
  for (const { name, record } of machines) {
    assert.deepEqual(allErrors(record), [], `${name} is invalid`);
  }
  assert.deepEqual(duplicateIdErrors(machines), [], 'duplicate machine ids');
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
