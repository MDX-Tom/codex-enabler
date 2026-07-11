#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const mainScript = join(import.meta.dirname, 'chatgpt_app_feature_patcher.mjs');
const incoming = process.argv.slice(2);
const mapped = incoming.includes('--apply')
  ? ['--set', 'feature1', '--yes', ...incoming.filter((argument) => argument !== '--apply')]
  : incoming;

const child = spawn(process.execPath, [mainScript, ...mapped], { stdio: 'inherit' });
child.once('error', (error) => {
  console.error(`Could not start the interactive patcher: ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal != null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
