import assert from 'node:assert/strict';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  featureDefinitions,
  normalizeLanguage,
  parseAsarHeaderLayout,
  relocateManifestBackupFiles,
  resolveInstallPaths,
} from '../scripts/chatgpt_app_feature_patcher.mjs';

function asarPrefix(jsonLength) {
  const headerPicklePayloadSize = Math.ceil((4 + jsonLength) / 4) * 4;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(4 + headerPicklePayloadSize, 4);
  prefix.writeUInt32LE(headerPicklePayloadSize, 8);
  prefix.writeUInt32LE(jsonLength, 12);
  return prefix;
}

test('macOS paths target the unified ChatGPT app bundle', () => {
  const paths = resolveInstallPaths({
    targetPlatform: 'darwin',
    appOverride: '/Applications/ChatGPT.app',
  });
  assert.equal(paths.archivePath, '/Applications/ChatGPT.app/Contents/Resources/app.asar');
  assert.equal(paths.executablePath, '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT');
  assert.equal(paths.infoPlistPath, '/Applications/ChatGPT.app/Contents/Info.plist');
});

test('Windows paths support the unified ChatGPT install layout', () => {
  const paths = resolveInstallPaths({
    targetPlatform: 'win32',
    localAppData: 'C:\\Users\\tester\\AppData\\Local',
  });
  assert.equal(
    paths.executablePath,
    'C:\\Users\\tester\\AppData\\Local\\Programs\\ChatGPT\\ChatGPT.exe',
  );
  assert.equal(
    paths.archivePath,
    'C:\\Users\\tester\\AppData\\Local\\Programs\\ChatGPT\\resources\\app.asar',
  );
  assert.equal(paths.infoPlistPath, null);
});

test('patch expressions remain equal-length and model-agnostic', () => {
  for (const feature of featureDefinitions) {
    assert.equal(feature.originalExpression.length, feature.patchedExpression.length);
    for (const legacy of feature.legacyPatchedExpressions ?? []) {
      assert.equal(feature.originalExpression.length, legacy.length);
    }
    assert.doesNotMatch(feature.patchedExpression.toString('utf8'), /gpt-[0-9]/i);
  }
});

test('language selection defaults to English unless explicitly Chinese', () => {
  assert.equal(normalizeLanguage('en'), 'en');
  assert.equal(normalizeLanguage('en-US'), 'en');
  assert.equal(normalizeLanguage('zh-CN'), 'zh-CN');
  assert.equal(normalizeLanguage('zh-Hans'), 'zh-CN');
});

test('moved repositories relocate manifest backup files beside the manifest', () => {
  const oldPatchDirectory = resolve('old-repository', 'outputs', 'patches', 'PATCH_ID');
  const newPatchDirectory = resolve('new-repository', 'outputs', 'patches', 'PATCH_ID');
  const manifestPath = join(newPatchDirectory, 'manifest.json');
  const manifest = {
    backup_files: {
      app_asar: join(oldPatchDirectory, 'app.asar'),
      info_plist: join(oldPatchDirectory, 'Info.plist'),
    },
  };
  const existing = new Set([
    join(newPatchDirectory, 'app.asar'),
    join(newPatchDirectory, 'Info.plist'),
  ]);
  const relocated = relocateManifestBackupFiles(
    manifest,
    manifestPath,
    (path) => existing.has(path),
  );
  assert.equal(dirname(manifestPath), newPatchDirectory);
  assert.equal(basename(relocated.backup_files.app_asar), 'app.asar');
  assert.equal(basename(relocated.backup_files.info_plist), 'Info.plist');
  assert.equal(relocated.backup_files.app_asar, join(newPatchDirectory, 'app.asar'));
  assert.equal(relocated.backup_files.info_plist, join(newPatchDirectory, 'Info.plist'));
});

test('ASAR parsing follows Pickle alignment instead of a fixed app-version layout', () => {
  for (const [jsonLength, expectedPadding] of [
    [100, 0],
    [101, 3],
    [102, 2],
    [103, 1],
  ]) {
    const layout = parseAsarHeaderLayout(asarPrefix(jsonLength), 1_000_000);
    assert.equal(layout.jsonLength, jsonLength);
    assert.equal(layout.paddingLength, expectedPadding);
    assert.equal(layout.dataOffset, layout.headerOffset + jsonLength + expectedPadding);
  }
});

test('ASAR parsing rejects inconsistent Pickle length fields', () => {
  const prefix = asarPrefix(101);
  prefix.writeUInt32LE(prefix.readUInt32LE(4) + 4, 4);
  assert.throws(() => parseAsarHeaderLayout(prefix, 1_000_000), /Pickle header/);
});
