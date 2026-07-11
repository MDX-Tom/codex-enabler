#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const mainScript = join(import.meta.dirname, 'chatgpt_app_feature_patcher.mjs');
const child = spawn(process.execPath, [mainScript, '--status', ...process.argv.slice(2)], {
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error(`Could not run patch validation: ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal != null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
