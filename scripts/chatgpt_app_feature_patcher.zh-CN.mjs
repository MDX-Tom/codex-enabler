#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const mainScript = join(import.meta.dirname, 'chatgpt_app_feature_patcher.mjs');
const child = spawn(process.execPath, [mainScript, '--lang', 'zh-CN', ...process.argv.slice(2)], {
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error(`无法启动中文版补丁工具：${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal != null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
