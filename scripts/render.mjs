#!/usr/bin/env node
// Rewrite the table between the README machines markers from machines/*.json.
// With --check it reports staleness and exits nonzero instead of writing.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { duplicateIdErrors, loadMachines, nonIdentifyingErrors, renderTable, validateRecord } from './lib/inventory.mjs';

export const MACHINES_START = '<!-- machines:start -->';
export const MACHINES_END = '<!-- machines:end -->';

const README = 'README.md';
const DIR = 'machines';

export function renderReadme(text, table) {
  const start = text.indexOf(MACHINES_START);
  const end = start === -1 ? -1 : text.indexOf(MACHINES_END, start + MACHINES_START.length);
  if (start === -1 || end === -1) throw new Error('README.md is missing the machines markers');
  return `${text.slice(0, start + MACHINES_START.length)}\n${table}\n${text.slice(end)}`;
}

function main() {
  const check = process.argv.slice(2).includes('--check');
  const current = readFileSync(README, 'utf8');
  const records = loadMachines(DIR);

  const problems = [];
  for (const { name, record } of records) {
    for (const message of validateRecord(record)) problems.push(`${name}: ${message}`);
    for (const message of nonIdentifyingErrors(record)) problems.push(`${name}: ${message}`);
  }
  for (const message of duplicateIdErrors(records)) problems.push(message);
  if (problems.length > 0) {
    for (const message of problems) process.stdout.write(`render: ${message}\n`);
    process.stdout.write('render: refusing to write; fix the records above\n');
    process.exit(1);
  }

  const next = renderReadme(current, renderTable(records));

  if (check) {
    if (next !== current) {
      process.stdout.write('render: README machine table is stale, run "just render"\n');
      process.exit(1);
    }
    process.stdout.write('render: ok\n');
    process.exit(0);
  }

  if (next !== current) writeFileSync(README, next);
  process.stdout.write(`render: wrote ${records.length} machines to README.md\n`);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
