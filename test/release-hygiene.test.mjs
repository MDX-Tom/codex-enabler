import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rootUrl = new URL('../', import.meta.url);

test('local backups and handoff state are excluded from Git', async () => {
  const ignore = await readFile(new URL('.gitignore', rootUrl), 'utf8');
  assert.match(ignore, /^outputs\/$/m);
  assert.match(ignore, /^codex\/$/m);
  assert.match(ignore, /^AGENTS\.md$/m);
  assert.match(ignore, /\.DS_Store/);
});

test('English and Chinese public entrypoints link to each other', async () => {
  const english = await readFile(new URL('README.md', rootUrl), 'utf8');
  const chinese = await readFile(new URL('README.zh-CN.md', rootUrl), 'utf8');
  assert.match(english, /README\.zh-CN\.md/);
  assert.match(chinese, /README\.md/);
  assert.match(english, /Windows.*experimental/is);
  assert.match(chinese, /Windows.*实验/is);
});

test('public screenshots exist in both languages', async () => {
  for (const path of [
    'docs/images/model-picker-en.png',
    'docs/images/fast-option-en.png',
    'docs/images/model-picker-zh-CN.png',
    'docs/images/fast-option-zh-CN.png',
  ]) {
    const bytes = await readFile(new URL(path, rootUrl));
    assert.ok(bytes.length > 10_000, `${path} is unexpectedly small`);
  }
});
