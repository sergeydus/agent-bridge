#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const [major = 0, minor = 0] = process.versions.node
  .split('.')
  .map((value) => Number(value));
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(
    `Agent Bridge requires Node.js 22.6 or newer; found ${process.version}.`,
  );
  process.exit(1);
}

const compiledCli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const sourceCli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const cli = existsSync(compiledCli) ? compiledCli : sourceCli;
const nodeArguments = existsSync(compiledCli)
  ? [cli]
  : ['--experimental-strip-types', cli];
const child = spawn(
  process.execPath,
  [...nodeArguments, ...process.argv.slice(2)],
  {
    env: process.env,
    stdio: 'inherit',
  },
);

child.once('error', (error) => {
  console.error(`Agent Bridge failed to start: ${error.message}`);
  process.exit(1);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}
child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
