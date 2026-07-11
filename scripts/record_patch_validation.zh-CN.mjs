#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const mainScript = join(import.meta.dirname, 'record_patch_validation.mjs');
const child = spawn(process.execPath, [mainScript, '--lang', 'zh-CN', ...process.argv.slice(2)], {
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error(`无法运行中文版补丁状态验证：${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal != null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
