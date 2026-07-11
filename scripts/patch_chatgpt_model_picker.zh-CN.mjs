#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const mainScript = join(import.meta.dirname, 'patch_chatgpt_model_picker.mjs');
const child = spawn(process.execPath, [mainScript, '--lang', 'zh-CN', ...process.argv.slice(2)], {
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error(`无法启动模型菜单补丁兼容入口：${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal != null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
