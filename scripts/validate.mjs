#!/usr/bin/env node
// Validate every machines/*.json record against the schema and the
// non-identifying rules. Exits nonzero on any problem.
import { duplicateIdErrors, loadMachines, nonIdentifyingErrors, validateRecord } from './lib/inventory.mjs';

const dir = process.argv[2] ?? 'machines';

function recordErrors({ name, record }) {
  return [...validateRecord(record), ...nonIdentifyingErrors(record)].map((message) => `${name}: ${message}`);
}

function main() {
  let machines;
  try {
    machines = loadMachines(dir);
  } catch (error) {
    process.stdout.write(`validate: ${error.message}\n`);
    process.exit(1);
  }

  const errors = [];
  for (const machine of machines) {
    for (const message of recordErrors(machine)) errors.push(message);
  }
  for (const message of duplicateIdErrors(machines)) errors.push(message);

  if (errors.length > 0) {
    for (const message of errors) process.stdout.write(`validate: ${message}\n`);
    process.exit(1);
  }
  process.stdout.write(`validate: ok (${machines.length} machines)\n`);
  process.exit(0);
}

main();
