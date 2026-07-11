#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve, win32 as winPath } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const toolVersion = '0.2.1';
const workspace = resolve(import.meta.dirname, '..');
const outputRoot = join(workspace, 'outputs');
const patchesRoot = join(outputRoot, 'patches');
const activeFeaturePatchPath = join(outputRoot, 'active-chatgpt-feature-patch.json');
const baselineRegistryPath = join(outputRoot, 'chatgpt-official-baselines.json');
const localEntitlementsPath = join(workspace, 'scripts/chatgpt-local-signing-entitlements.plist');

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function hasArgument(name) {
  return process.argv.includes(name);
}

function normalizeLanguage(value) {
  return String(value).toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

const language = normalizeLanguage(argumentValue('--lang') ?? process.env.CHATGPT_PATCHER_LANG ?? 'en');
const localize = (english, chinese) => language === 'zh-CN' ? chinese : english;
const platform = argumentValue('--platform') ?? process.platform;
if (!['darwin', 'win32'].includes(platform)) {
  throw new Error(localize(
    `Unsupported platform: ${platform}. Only macOS and experimental Windows are supported.`,
    `不支持的平台：${platform}。目前仅支持 macOS 和实验性 Windows。`,
  ));
}
const isMac = platform === 'darwin';
const isWindows = platform === 'win32';

export function resolveInstallPaths({
  targetPlatform,
  appOverride = null,
  resourcesOverride = null,
  localAppData = process.env.LOCALAPPDATA ?? null,
} = {}) {
  if (targetPlatform === 'darwin') {
    const app = resolve(appOverride ?? '/Applications/ChatGPT.app');
    const resources = resolve(resourcesOverride ?? join(app, 'Contents/Resources'));
    return {
      appPath: app,
      archivePath: join(resources, 'app.asar'),
      codeResourcesPath: join(app, 'Contents/_CodeSignature/CodeResources'),
      executablePath: join(app, 'Contents/MacOS/ChatGPT'),
      infoPlistPath: join(app, 'Contents/Info.plist'),
      resourcesPath: resources,
    };
  }

  if (targetPlatform === 'win32') {
    const base = localAppData == null ? null : winPath.resolve(localAppData);
    const candidates = appOverride != null
      ? [winPath.resolve(appOverride)]
      : base == null
        ? []
        : [
            winPath.join(base, 'Programs/ChatGPT/ChatGPT.exe'),
            winPath.join(base, 'Programs/Codex/Codex.exe'),
            winPath.join(base, 'ChatGPT/ChatGPT.exe'),
          ];
    if (candidates.length === 0) {
      throw new Error('LOCALAPPDATA is not set; pass --app and optionally --resources.');
    }
    let executable = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
    if (!executable.toLowerCase().endsWith('.exe')) {
      const directoryCandidates = [
        winPath.join(executable, 'ChatGPT.exe'),
        winPath.join(executable, 'Codex.exe'),
      ];
      executable = directoryCandidates.find((candidate) => existsSync(candidate)) ?? directoryCandidates[0];
    }
    const resources = winPath.resolve(resourcesOverride ?? winPath.join(winPath.dirname(executable), 'resources'));
    return {
      appPath: executable,
      archivePath: winPath.join(resources, 'app.asar'),
      codeResourcesPath: null,
      executablePath: executable,
      infoPlistPath: null,
      resourcesPath: resources,
    };
  }

  throw new Error(`Unsupported platform: ${targetPlatform}`);
}

const installPaths = resolveInstallPaths({
  targetPlatform: platform,
  appOverride: argumentValue('--app'),
  resourcesOverride: argumentValue('--resources'),
});
const {
  appPath,
  archivePath,
  codeResourcesPath,
  executablePath,
  infoPlistPath,
  resourcesPath,
} = installPaths;

const featureDefinitions = [
  {
    id: 'new-models',
    number: 1,
    label: {
      en: 'Feature 1: follow new model releases and restore models missing from the App picker',
      'zh-CN': '功能 1：及时跟进新模型，并补全 App 模型菜单中缺失的模型',
    },
    shortLabel: { en: 'New model visibility', 'zh-CN': '新模型显示' },
    originalExpression: Buffer.from('l=o&&e!==`amazonBedrock`', 'utf8'),
    patchedExpression: Buffer.from('l=!1/*use hidden flag*/ ', 'utf8'),
  },
  {
    id: 'api-key-fast',
    number: 2,
    label: {
      en: 'Feature 2: show model-declared Fast/Priority options in API-key mode',
      'zh-CN': '功能 2：API key 登录时显示模型声明支持的 Fast/Priority 选项',
    },
    shortLabel: { en: 'API-key Fast', 'zh-CN': 'API key Fast' },
    originalExpression: Buffer.from(
      'a&&!u&&c!=null&&c?.requirements?.featureRequirements?.fast_mode!==!1',
      'utf8',
    ),
    patchedExpression: Buffer.from(
      '!u&&(a?!!c&&c.requirements?.featureRequirements?.fast_mode!==!1:!0) ',
      'utf8',
    ),
    legacyPatchedExpressions: [
      Buffer.from(
        '!u&&(a?!!c&&c.requirements?.featureRequirements?.fast_mode!==!1:!!o)',
        'utf8',
      ),
    ],
  },
];

function featureText(feature, key = 'label') {
  return feature[key][language] ?? feature[key].en;
}

for (const feature of featureDefinitions) {
  if (feature.originalExpression.length !== feature.patchedExpression.length) {
    throw new Error(localize(
      `${featureText(feature)} has different original and patched expression lengths.`,
      `${featureText(feature)} 的默认表达式和补丁表达式长度不一致。`,
    ));
  }
  for (const legacyExpression of feature.legacyPatchedExpressions ?? []) {
    if (feature.originalExpression.length !== legacyExpression.length) {
      throw new Error(localize(
        `${featureText(feature)} has an incompatible legacy expression length.`,
        `${featureText(feature)} 的旧版补丁表达式长度不一致。`,
      ));
    }
  }
}
const noQuit = hasArgument('--no-quit');
const noLaunch = hasArgument('--no-launch');
const assumeYes = hasArgument('--yes');
const dryRun = hasArgument('--dry-run');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function capture(command, args) {
  try {
    const { stdout = '', stderr = '' } = await execFileAsync(command, args, {
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    return {
      ok: false,
      code: typeof error?.code === 'number' ? error.code : null,
      output: `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim(),
    };
  }
}

async function plistValue(key, plistPath = infoPlistPath) {
  if (plistPath == null) {
    throw new Error(localize('Info.plist is only available on macOS.', 'Info.plist 仅适用于 macOS。'));
  }
  const result = await capture('/usr/bin/plutil', ['-extract', key, 'raw', plistPath]);
  if (!result.ok) {
    throw new Error(localize(
      `Could not read ${key} from Info.plist: ${result.output}`,
      `无法从 Info.plist 读取 ${key}：${result.output}`,
    ));
  }
  return result.output;
}

function indexesOf(haystack, needle) {
  const indexes = [];
  let start = 0;
  while (start <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, start);
    if (index === -1) {
      break;
    }
    indexes.push(index);
    start = index + 1;
  }
  return indexes;
}

function blockHashes(content, blockSize) {
  const hashes = [];
  for (let start = 0; start < content.length; start += blockSize) {
    hashes.push(sha256(content.subarray(start, Math.min(start + blockSize, content.length))));
  }
  return hashes;
}

export function parseAsarHeaderLayout(prefix, archiveSize = null) {
  if (!Buffer.isBuffer(prefix) || prefix.length < 16) {
    throw new Error(localize(
      'The app.asar header is truncated.',
      'app.asar header 不完整。',
    ));
  }

  const sizePicklePayloadSize = prefix.readUInt32LE(0);
  const headerSize = prefix.readUInt32LE(4);
  const headerPicklePayloadSize = prefix.readUInt32LE(8);
  const jsonLength = prefix.readUInt32LE(12);
  const headerOffset = 16;
  const dataOffset = 8 + headerSize;
  const jsonEndOffset = headerOffset + jsonLength;
  const paddingLength = dataOffset - jsonEndOffset;
  const expectedHeaderPicklePayloadSize = Math.ceil((4 + jsonLength) / 4) * 4;

  if (
    sizePicklePayloadSize !== 4
    || headerPicklePayloadSize !== expectedHeaderPicklePayloadSize
    || headerSize !== 4 + headerPicklePayloadSize
    || paddingLength < 0
    || paddingLength > 3
    || (archiveSize != null && (!Number.isSafeInteger(archiveSize) || dataOffset > archiveSize))
  ) {
    throw new Error(localize(
      'The app.asar Pickle header is malformed or unsupported.',
      'app.asar Pickle header 格式无效或不受支持。',
    ));
  }

  return {
    dataOffset,
    headerOffset,
    headerPicklePayloadSize,
    headerSize,
    jsonLength,
    paddingLength,
    sizePicklePayloadSize,
  };
}

async function readExact(handle, length, position, description) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) {
      throw new Error(localize(
        `The app.asar ended while reading ${description}.`,
        `读取 ${description} 时 app.asar 意外结束。`,
      ));
    }
    offset += bytesRead;
  }
  return buffer;
}

async function readAsarHeader(handle) {
  const archiveSize = (await handle.stat()).size;
  const prefix = await readExact(handle, 16, 0, 'the ASAR header prefix');
  const layout = parseAsarHeaderLayout(prefix, archiveSize);
  const headerBytes = await readExact(
    handle,
    layout.jsonLength,
    layout.headerOffset,
    'the ASAR header JSON',
  );
  const paddingBytes = await readExact(
    handle,
    layout.paddingLength,
    layout.headerOffset + layout.jsonLength,
    'the ASAR header padding',
  );
  if (paddingBytes.some((byte) => byte !== 0)) {
    throw new Error(localize(
      'The app.asar header has invalid non-zero Pickle padding.',
      'app.asar header 的 Pickle 对齐填充包含非零字节。',
    ));
  }

  const header = JSON.parse(headerBytes.toString('utf8'));
  if (!Buffer.from(JSON.stringify(header), 'utf8').equals(headerBytes)) {
    throw new Error(localize(
      'The app.asar header cannot be round-tripped safely.',
      'app.asar header 无法稳定进行 JSON round-trip。',
    ));
  }
  return { ...layout, header, headerBytes };
}

function collectPackedEntries(node, prefix = '', entries = []) {
  for (const [name, value] of Object.entries(node?.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (value?.files != null) {
      collectPackedEntries(value, path, entries);
      continue;
    }
    if (typeof value?.offset === 'string' && typeof value?.size === 'number') {
      entries.push({ entry: value, path });
    }
  }
  return entries;
}

function featureState(matches) {
  if (matches.original.length === 1 && matches.patched.length === 0 && matches.legacy.length === 0) {
    return 'default';
  }
  if (matches.original.length === 0 && matches.patched.length === 1 && matches.legacy.length === 0) {
    return 'added';
  }
  if (matches.original.length === 0 && matches.patched.length === 0 && matches.legacy.length === 1) {
    return 'legacy';
  }
  return 'unknown';
}

function stateText(state) {
  if (state === 'added') {
    return localize('enabled', '已添加');
  }
  if (state === 'default') {
    return localize('default', '默认');
  }
  if (state === 'legacy') {
    return localize('legacy patch (migration required)', '旧版补丁（需修复）');
  }
  return localize('unrecognized (will not modify)', '无法识别（不会修改）');
}

async function inspectArchive(asarPath = archivePath, plistPath = infoPlistPath) {
  const handle = await open(asarPath, 'r');
  try {
    const {
      dataOffset,
      header,
      headerBytes,
      headerOffset,
      paddingLength,
    } = await readAsarHeader(handle);

    const entries = collectPackedEntries(header);
    const candidates = entries.filter(({ path }) => path.startsWith('webview/assets/') && path.endsWith('.js'));
    const matches = Object.fromEntries(featureDefinitions.map((feature) => [
      feature.id,
      { original: [], patched: [], legacy: [] },
    ]));
    const contentByPath = new Map();
    const verifiedPaths = new Set();

    for (const candidate of candidates) {
      if (candidate.entry.size < Math.min(...featureDefinitions.map((item) => item.originalExpression.length))) {
        continue;
      }
      const absoluteOffset = dataOffset + Number(candidate.entry.offset);
      const content = await readExact(handle, candidate.entry.size, absoluteOffset, candidate.path);

      let containsKnownExpression = false;
      for (const feature of featureDefinitions) {
        const originalIndexes = indexesOf(content, feature.originalExpression);
        const patchedIndexes = indexesOf(content, feature.patchedExpression);
        const legacyMatches = (feature.legacyPatchedExpressions ?? []).flatMap((expression) => (
          indexesOf(content, expression).map((index) => ({ expression, index }))
        ));
        if (originalIndexes.length > 0 || patchedIndexes.length > 0 || legacyMatches.length > 0) {
          containsKnownExpression = true;
        }
        matches[feature.id].original.push(...originalIndexes.map((index) => ({
          absoluteOffset: absoluteOffset + index,
          assetOffset: index,
          path: candidate.path,
        })));
        matches[feature.id].patched.push(...patchedIndexes.map((index) => ({
          absoluteOffset: absoluteOffset + index,
          assetOffset: index,
          path: candidate.path,
        })));
        matches[feature.id].legacy.push(...legacyMatches.map(({ expression, index }) => ({
          absoluteOffset: absoluteOffset + index,
          assetOffset: index,
          expression,
          path: candidate.path,
        })));
      }

      if (!containsKnownExpression) {
        continue;
      }

      const integrity = candidate.entry.integrity;
      const contentHash = sha256(content);
      if (integrity?.algorithm !== 'SHA256' || integrity.hash !== contentHash) {
        throw new Error(localize(
          `${candidate.path} has an invalid asset integrity hash.`,
          `${candidate.path} 的 asset integrity hash 不匹配。`,
        ));
      }
      const calculatedBlocks = blockHashes(content, integrity.blockSize);
      if (JSON.stringify(calculatedBlocks) !== JSON.stringify(integrity.blocks)) {
        throw new Error(localize(
          `${candidate.path} has invalid block hashes.`,
          `${candidate.path} 的 block hashes 不匹配。`,
        ));
      }
      contentByPath.set(candidate.path, content);
      verifiedPaths.add(candidate.path);
    }

    const headerHash = sha256(headerBytes);
    let plistBytes = null;
    let plistHashOffset = null;
    if (plistPath != null) {
      plistBytes = await readFile(plistPath);
      const hashIndexes = indexesOf(plistBytes, Buffer.from(headerHash, 'ascii'));
      if (hashIndexes.length !== 1) {
        throw new Error(localize(
          'Info.plist does not contain one matching Electron ASAR header hash.',
          'Info.plist 未包含唯一匹配的 Electron ASAR header hash。',
        ));
      }
      [plistHashOffset] = hashIndexes;
    }

    const entryByPath = new Map(entries.map((item) => [item.path, item.entry]));
    const states = Object.fromEntries(featureDefinitions.map((feature) => [
      feature.id,
      featureState(matches[feature.id]),
    ]));

    return {
      asarPath,
      contentByPath,
      dataOffset,
      entries,
      entryByPath,
      header,
      headerBytes,
      headerHash,
      headerOffset,
      matches,
      paddingLength,
      plistBytes,
      plistHashOffset,
      plistPath,
      states,
      verifiedPaths,
    };
  } finally {
    await handle.close();
  }
}

function currentMatch(inspection, feature, state = inspection.states[feature.id]) {
  if (state === 'default') {
    return inspection.matches[feature.id].original[0];
  }
  if (state === 'added') {
    return inspection.matches[feature.id].patched[0];
  }
  if (state === 'legacy') {
    return inspection.matches[feature.id].legacy[0];
  }
  return null;
}

function buildPatchedBuffers(inspection, desiredStates) {
  const modifiedContentByPath = new Map();
  const changes = [];

  for (const feature of featureDefinitions) {
    const desired = desiredStates[feature.id];
    const current = inspection.states[feature.id];
    if (desired == null || desired === current) {
      continue;
    }
    if (current === 'unknown') {
      throw new Error(localize(
        `${featureText(feature)} cannot be identified uniquely; refusing to modify the App.`,
        `${featureText(feature)} 的当前代码无法唯一识别，已拒绝修改。`,
      ));
    }
    if (!['default', 'added'].includes(desired)) {
      throw new Error(localize(
        `${featureText(feature)} has an invalid target state: ${desired}`,
        `${featureText(feature)} 的目标状态无效：${desired}`,
      ));
    }

    const match = currentMatch(inspection, feature, current);
    if (match == null) {
      throw new Error(localize(
        `${featureText(feature)} has no unique current expression.`,
        `${featureText(feature)} 缺少唯一的当前表达式。`,
      ));
    }
    const source = current === 'default'
      ? feature.originalExpression
      : current === 'legacy'
        ? match.expression
        : feature.patchedExpression;
    const replacement = desired === 'default' ? feature.originalExpression : feature.patchedExpression;
    let content = modifiedContentByPath.get(match.path);
    if (content == null) {
      const originalContent = inspection.contentByPath.get(match.path);
      if (originalContent == null) {
        throw new Error(localize(
          `Target asset was not cached: ${match.path}`,
          `未缓存目标 asset：${match.path}`,
        ));
      }
      content = Buffer.from(originalContent);
      modifiedContentByPath.set(match.path, content);
    }
    if (!content.subarray(match.assetOffset, match.assetOffset + source.length).equals(source)) {
      throw new Error(localize(
        `${featureText(feature)} target bytes changed unexpectedly.`,
        `${featureText(feature)} 的目标字节已变化。`,
      ));
    }
    replacement.copy(content, match.assetOffset);
    changes.push({
      feature: feature.id,
      from: current,
      to: desired,
      asset_path: match.path,
      asset_offset: match.assetOffset,
      absolute_offset: match.absoluteOffset,
      expression_length: source.length,
      original_expression: feature.originalExpression.toString('utf8'),
      patched_expression: feature.patchedExpression.toString('utf8'),
    });
  }

  if (changes.length === 0) {
    return null;
  }

  const assetHashes = {};
  for (const [path, content] of modifiedContentByPath.entries()) {
    const entry = inspection.entryByPath.get(path);
    if (entry == null) {
      throw new Error(localize(`Could not locate ASAR entry: ${path}`, `无法定位目标 ASAR entry：${path}`));
    }
    const contentHash = sha256(content);
    const blocks = blockHashes(content, entry.integrity.blockSize);
    if (blocks.length !== entry.integrity.blocks.length) {
      throw new Error(localize(
        `Patching ${path} would change the ASAR block layout.`,
        `${path} 的补丁会改变 ASAR block 布局。`,
      ));
    }
    entry.integrity.hash = contentHash;
    entry.integrity.blocks = blocks;
    assetHashes[path] = contentHash;
  }

  const headerBytes = Buffer.from(JSON.stringify(inspection.header), 'utf8');
  if (headerBytes.length !== inspection.headerBytes.length) {
    throw new Error(localize(
      'The patch would change the app.asar header length.',
      '补丁会改变 app.asar header 长度。',
    ));
  }
  const headerHash = sha256(headerBytes);
  let plistBytes = null;
  if (inspection.plistBytes != null && inspection.plistHashOffset != null) {
    plistBytes = Buffer.from(inspection.plistBytes);
    Buffer.from(headerHash, 'ascii').copy(plistBytes, inspection.plistHashOffset);
  }

  return {
    assetHashes,
    changes,
    headerBytes,
    headerHash,
    modifiedContentByPath,
    plistBytes,
  };
}

async function atomicRestore(source, target, mode) {
  const temporary = `${target}.codex-restore.tmp`;
  await rm(temporary, { force: true });
  await copyFile(source, temporary);
  if (mode != null) {
    await chmod(temporary, mode);
  }
  await rename(temporary, target);
}

async function quitApp() {
  if (noQuit) {
    return;
  }
  if (isMac) {
    await capture('/usr/bin/osascript', ['-e', 'tell application id "com.openai.codex" to quit']);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const running = await capture('/usr/bin/pgrep', ['-f', executablePath]);
      if (!running.ok) {
        return;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  } else {
    const imageName = basename(executablePath);
    await capture('taskkill.exe', ['/IM', imageName, '/T', '/F']);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const running = await capture('tasklist.exe', ['/FI', `IMAGENAME eq ${imageName}`, '/NH']);
      if (!running.ok || !running.output.toLowerCase().includes(imageName.toLowerCase())) {
        return;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw new Error(localize(
    'The ChatGPT/Codex App did not exit within 10 seconds.',
    'ChatGPT/Codex App 在 10 秒内未退出。',
  ));
}

async function launchApp() {
  if (noLaunch || noQuit) {
    return;
  }
  if (isMac) {
    const result = await capture('/usr/bin/open', [appPath]);
    if (!result.ok) {
      throw new Error(localize(
        `The patch was written, but the App could not be relaunched: ${result.output}`,
        `补丁已写入，但重新启动 App 失败：${result.output}`,
      ));
    }
    return;
  }
  try {
    const child = spawn(executablePath, [], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (error) {
    throw new Error(localize(
      `The patch was written, but the App could not be relaunched: ${error.message}`,
      `补丁已写入，但重新启动 App 失败：${error.message}`,
    ));
  }
}

function timestampForPath() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function shellQuote(value) {
  if (isWindows) {
    return `"${String(value).replaceAll('"', '\\"')}"`;
  }
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function signatureKind(signature, gatekeeper) {
  if (isWindows) {
    if (/^Valid\b/im.test(signature.output) && /OpenAI/i.test(signature.output)) {
      return 'official-openai-windows';
    }
    return 'modified-or-unverified-windows';
  }
  if (signature.output.includes('Authority=Developer ID Application: OpenAI') && gatekeeper.ok) {
    return 'official-openai';
  }
  if (signature.output.includes('Signature=adhoc') || !signature.output.includes('Authority=')) {
    return 'ad-hoc';
  }
  return 'other';
}

async function asarPackageMetadata() {
  const handle = await open(archivePath, 'r');
  try {
    const { dataOffset, header } = await readAsarHeader(handle);
    const entry = header?.files?.['package.json'];
    if (typeof entry?.offset !== 'string' || typeof entry?.size !== 'number') {
      return { version: 'unknown', buildNumber: 'unknown' };
    }
    const bytes = await readExact(
      handle,
      entry.size,
      dataOffset + Number(entry.offset),
      'package.json',
    );
    const metadata = JSON.parse(bytes.toString('utf8'));
    return {
      version: String(metadata.version ?? 'unknown'),
      buildNumber: String(metadata.codexBuildNumber ?? metadata.buildNumber ?? 'unknown'),
    };
  } finally {
    await handle.close();
  }
}

async function appMetadata() {
  const packageMetadata = await asarPackageMetadata();
  if (isWindows) {
    const quotedPath = executablePath.replaceAll("'", "''");
    const signature = await capture('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$s=Get-AuthenticodeSignature -LiteralPath '${quotedPath}'; Write-Output $s.Status; Write-Output $s.SignerCertificate.Subject`,
    ]);
    const gatekeeper = { ok: null, output: 'Not applicable on Windows' };
    return {
      appVersion: packageMetadata.version,
      bundleVersion: packageMetadata.buildNumber,
      gatekeeper,
      signature,
      signatureKind: signatureKind(signature, gatekeeper),
    };
  }
  const [appVersion, bundleVersion, signature, gatekeeper] = await Promise.all([
    plistValue('CFBundleShortVersionString'),
    plistValue('CFBundleVersion'),
    capture('/usr/bin/codesign', ['-dvvv', '--entitlements', ':-', appPath]),
    capture('/usr/sbin/spctl', ['-a', '-vv', appPath]),
  ]);
  return {
    appVersion,
    bundleVersion,
    gatekeeper,
    signature,
    signatureKind: signatureKind(signature, gatekeeper),
  };
}

const currentPaths = {
  app_asar: archivePath,
  executable: executablePath,
  ...(infoPlistPath == null ? {} : { info_plist: infoPlistPath }),
  ...(codeResourcesPath == null ? {} : { code_resources: codeResourcesPath }),
};

async function createBackup({ action, desiredStates, inspection, metadata }) {
  const backupDirectory = join(patchesRoot, `${timestampForPath()}-${action}`);
  await mkdir(backupDirectory, { recursive: true });
  const backupFiles = Object.fromEntries(Object.entries(currentPaths).map(([key, path]) => [
    key,
    join(backupDirectory, basename(path)),
  ]));
  const originalModes = {};
  for (const key of Object.keys(backupFiles)) {
    originalModes[key] = (await stat(currentPaths[key])).mode & 0o777;
    await copyFile(currentPaths[key], backupFiles[key]);
  }

  const originalHashes = {};
  for (const key of Object.keys(backupFiles)) {
    originalHashes[key] = await sha256File(backupFiles[key]);
  }
  originalHashes.asar_header = inspection.headerHash;
  for (const path of inspection.verifiedPaths) {
    originalHashes[`asset:${path}`] = sha256(inspection.contentByPath.get(path));
  }

  await writeFile(join(backupDirectory, 'signature-before.txt'), `${metadata.signature.output}\n`);
  await writeFile(join(backupDirectory, 'gatekeeper-before.txt'), `${metadata.gatekeeper.output}\n`);

  const manifestPath = join(backupDirectory, 'manifest.json');
  const manifest = {
    schema_version: 2,
    platform,
    status: 'backup-created',
    created_at: new Date().toISOString(),
    action,
    workspace,
    app_path: appPath,
    app_version: metadata.appVersion,
    bundle_version: metadata.bundleVersion,
    pre_state: {
      feature_states: inspection.states,
      signature_kind: metadata.signatureKind,
      gatekeeper_accepted: metadata.gatekeeper.ok ?? null,
    },
    desired_states: desiredStates,
    backup_directory: backupDirectory,
    backup_files: backupFiles,
    original_paths: currentPaths,
    original_modes: originalModes,
    original_hashes: originalHashes,
    post_hashes: {},
    rollback_command: `node ${shellQuote(join(workspace, 'scripts/chatgpt_app_feature_patcher.mjs'))} --restore-manifest ${shellQuote(manifestPath)} --yes`,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { backupDirectory, backupFiles, manifest, manifestPath };
}

async function restoreBackupFiles(backup) {
  for (const key of Object.keys(backup.backupFiles)) {
    await atomicRestore(backup.backupFiles[key], currentPaths[key], backup.manifest.original_modes[key]);
  }
}

async function verifyRestoredHashes(manifest) {
  for (const key of Object.keys(manifest.backup_files)) {
    const actual = await sha256File(currentPaths[key]);
    if (actual !== manifest.original_hashes[key]) {
      throw new Error(localize(
        `Restored ${key} SHA-256 does not match the manifest.`,
        `恢复后的 ${key} SHA-256 不匹配。`,
      ));
    }
  }
}

async function writeManifest(backup) {
  await writeFile(backup.manifestPath, `${JSON.stringify(backup.manifest, null, 2)}\n`);
}

async function recordPostHashes(manifest) {
  for (const key of Object.keys(currentPaths)) {
    manifest.post_hashes[key] = await sha256File(currentPaths[key]);
  }
}

async function loadRegistry() {
  if (!(await pathExists(baselineRegistryPath))) {
    return { schema_version: 1, baselines: [] };
  }
  return JSON.parse(await readFile(baselineRegistryPath, 'utf8'));
}

async function registerOfficialBaseline(backup) {
  const registry = await loadRegistry();
  const key = `${backup.manifest.app_version}:${backup.manifest.bundle_version}`;
  registry.baselines = registry.baselines.filter((entry) => entry.key !== key);
  registry.baselines.push({
    key,
    app_version: backup.manifest.app_version,
    bundle_version: backup.manifest.bundle_version,
    manifest_path: backup.manifestPath,
    registered_at: new Date().toISOString(),
  });
  await mkdir(dirname(baselineRegistryPath), { recursive: true });
  await writeFile(baselineRegistryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

async function candidateManifestPaths() {
  const paths = [];
  const registry = await loadRegistry();
  paths.push(...registry.baselines.map((entry) => entry.manifest_path));
  if (await pathExists(patchesRoot)) {
    for (const entry of await readdir(patchesRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        paths.push(join(patchesRoot, entry.name, 'manifest.json'));
      }
    }
  }
  return [...new Set(paths)];
}

async function manifestLooksOfficial(manifest, manifestPath) {
  if (
    manifest.platform === 'win32'
    && Object.values(manifest.pre_state?.feature_states ?? {}).every((state) => state === 'default')
  ) {
    return true;
  }
  if (manifest.pre_state?.signature_kind === 'official-openai') {
    return true;
  }
  if (String(manifest.signing?.before ?? '').includes('Developer ID Application: OpenAI')) {
    return true;
  }
  const signaturePath = join(dirname(manifestPath), 'signature-before.txt');
  if (await pathExists(signaturePath)) {
    const text = await readFile(signaturePath, 'utf8');
    return text.includes('Authority=Developer ID Application: OpenAI');
  }
  return false;
}

async function findOfficialBaseline(metadata) {
  const candidates = [];
  for (const manifestPath of await candidateManifestPaths()) {
    if (!(await pathExists(manifestPath))) {
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    if (manifest.app_version !== metadata.appVersion || manifest.bundle_version !== metadata.bundleVersion) {
      continue;
    }
    if ((manifest.platform ?? 'darwin') !== platform) {
      continue;
    }
    if (!(await manifestLooksOfficial(manifest, manifestPath))) {
      continue;
    }
    if (manifest.backup_files == null || manifest.original_hashes == null) {
      continue;
    }
    if (!(await Promise.all(Object.values(manifest.backup_files).map(pathExists))).every(Boolean)) {
      continue;
    }
    try {
      const backupInspection = await inspectArchive(manifest.backup_files.app_asar, manifest.backup_files.info_plist);
      if (!featureDefinitions.every((feature) => backupInspection.states[feature.id] === 'default')) {
        continue;
      }
      let hashesMatch = true;
      for (const key of Object.keys(manifest.backup_files)) {
        if (await sha256File(manifest.backup_files[key]) !== manifest.original_hashes[key]) {
          hashesMatch = false;
          break;
        }
      }
      if (!hashesMatch) {
        continue;
      }
      candidates.push({ manifest, manifestPath });
    } catch {
      continue;
    }
  }
  candidates.sort((left, right) => String(right.manifest.created_at).localeCompare(String(left.manifest.created_at)));
  return candidates[0] ?? null;
}

async function stagePatchedFiles(inspection, patched, desiredStates) {
  const temporaryArchive = `${archivePath}.codex-feature-patch.tmp`;
  const temporaryPlist = infoPlistPath == null ? null : `${infoPlistPath}.codex-feature-patch.tmp`;
  await rm(temporaryArchive, { force: true });
  if (temporaryPlist != null) {
    await rm(temporaryPlist, { force: true });
  }
  await copyFile(archivePath, temporaryArchive);
  await chmod(temporaryArchive, (await stat(archivePath)).mode & 0o777);

  const handle = await open(temporaryArchive, 'r+');
  try {
    await handle.write(patched.headerBytes, 0, patched.headerBytes.length, inspection.headerOffset);
    for (const [path, content] of patched.modifiedContentByPath.entries()) {
      const entry = inspection.entryByPath.get(path);
      const absoluteOffset = inspection.dataOffset + Number(entry.offset);
      await handle.write(content, 0, content.length, absoluteOffset);
    }
  } finally {
    await handle.close();
  }
  if (temporaryPlist != null && patched.plistBytes != null) {
    await writeFile(temporaryPlist, patched.plistBytes, { mode: (await stat(infoPlistPath)).mode & 0o777 });
  }

  const staged = await inspectArchive(temporaryArchive, temporaryPlist);
  for (const feature of featureDefinitions) {
    const desired = desiredStates[feature.id];
    if (desired != null && staged.states[feature.id] !== desired) {
      throw new Error(localize(
        `${featureText(feature)} failed staged-state validation.`,
        `${featureText(feature)} 的 staged 状态验证失败。`,
      ));
    }
  }
  if (staged.headerHash !== patched.headerHash) {
    throw new Error(localize(
      'The staged ASAR header hash failed validation.',
      'staged ASAR header hash 验证失败。',
    ));
  }
  return { temporaryArchive, temporaryPlist };
}

async function signAndVerify({ patched = true } = {}) {
  if (isWindows) {
    if (!patched) {
      return {
        ok: true,
        output: 'Original Windows executable restored from the hash-verified backup.',
      };
    }
    const npxCommand = 'npx.cmd';
    const writeFuse = await capture(npxCommand, [
      '--yes',
      '@electron/fuses@1.8.0',
      'write',
      '--app', executablePath,
      'EnableEmbeddedAsarIntegrityValidation=off',
    ]);
    if (!writeFuse.ok) {
      throw new Error(localize(
        `Could not disable Electron embedded ASAR integrity validation on experimental Windows support: ${writeFuse.output}`,
        `Windows 实验支持无法关闭 Electron 内嵌 ASAR 完整性验证：${writeFuse.output}`,
      ));
    }
    const readFuse = await capture(npxCommand, [
      '--yes',
      '@electron/fuses@1.8.0',
      'read',
      '--app', executablePath,
    ]);
    if (
      !readFuse.ok
      || !/EnableEmbeddedAsarIntegrityValidation[^\n]*(false|disabled|off)/i.test(readFuse.output)
    ) {
      throw new Error(localize(
        `Windows Electron fuse verification failed: ${readFuse.output}`,
        `Windows Electron fuse 验证失败：${readFuse.output}`,
      ));
    }
    return { ok: true, output: `${writeFuse.output}\n${readFuse.output}`.trim() };
  }
  if (!patched) {
    const verification = await capture('/usr/bin/codesign', [
      '--verify', '--deep', '--strict', '--verbose=2', appPath,
    ]);
    if (!verification.ok) {
      throw new Error(localize(
        `codesign verification failed: ${verification.output}`,
        `codesign 验证失败：${verification.output}`,
      ));
    }
    return verification;
  }
  const signing = await capture('/usr/bin/codesign', [
    '--force',
    '--sign', '-',
    '--options', 'runtime',
    '--entitlements', localEntitlementsPath,
    appPath,
  ]);
  if (!signing.ok) {
    throw new Error(localize(`codesign failed: ${signing.output}`, `codesign 失败：${signing.output}`));
  }
  const verification = await capture('/usr/bin/codesign', [
    '--verify', '--deep', '--strict', '--verbose=2', appPath,
  ]);
  if (!verification.ok) {
    throw new Error(localize(
      `codesign verification failed: ${verification.output}`,
      `codesign 验证失败：${verification.output}`,
    ));
  }
  return verification;
}

async function applyDesiredStates(desiredStates, action) {
  const inspection = await inspectArchive();
  const patched = buildPatchedBuffers(inspection, desiredStates);
  if (patched == null) {
    return {
      changed: false,
      inspection,
      message: localize(
        'The current state already matches the requested action; nothing changed.',
        '当前状态已经符合所选操作，无需修改。',
      ),
    };
  }
  if (dryRun) {
    return { changed: false, dryRun: true, inspection, changes: patched.changes };
  }
  const metadata = await appMetadata();
  const backup = await createBackup({ action, desiredStates, inspection, metadata });
  if (
    (metadata.signatureKind === 'official-openai' || isWindows)
    && featureDefinitions.every((feature) => inspection.states[feature.id] === 'default')
  ) {
    await registerOfficialBaseline(backup);
  }

  await quitApp();
  let staged = null;
  try {
    staged = await stagePatchedFiles(inspection, patched, desiredStates);
    await rename(staged.temporaryArchive, archivePath);
    if (staged.temporaryPlist != null && infoPlistPath != null) {
      await rename(staged.temporaryPlist, infoPlistPath);
    }
    const verification = await signAndVerify();
    const finalInspection = await inspectArchive();
    for (const feature of featureDefinitions) {
      const desired = desiredStates[feature.id];
      if (desired != null && finalInspection.states[feature.id] !== desired) {
        throw new Error(localize(
          `${featureText(feature)} failed final-state validation.`,
          `${featureText(feature)} 的最终状态验证失败。`,
        ));
      }
    }

    const metadataAfter = await appMetadata();
    const signatureAfter = metadataAfter.signature;
    const gatekeeperAfter = metadataAfter.gatekeeper;
    await writeFile(join(backup.backupDirectory, 'signature-after.txt'), `${signatureAfter.output}\n`);
    await writeFile(join(backup.backupDirectory, 'gatekeeper-after.txt'), `${gatekeeperAfter.output}\n`);
    await recordPostHashes(backup.manifest);
    backup.manifest.status = 'applied';
    backup.manifest.applied_at = new Date().toISOString();
    backup.manifest.changes = patched.changes;
    backup.manifest.post_state = {
      feature_states: finalInspection.states,
      signature_kind: signatureKind(signatureAfter, gatekeeperAfter),
      gatekeeper_accepted: gatekeeperAfter.ok ?? null,
    };
    backup.manifest.validation = {
      asar_integrity: 'verified',
      electron_asar_integrity: isMac ? 'verified' : 'fuse-disabled-experimental',
      platform_verify: verification.output || 'valid on disk',
      platform_verify_ok: verification.ok,
      gatekeeper_accepted: gatekeeperAfter.ok ?? null,
      gatekeeper_output: gatekeeperAfter.output,
    };
    await writeManifest(backup);
    await writeFile(activeFeaturePatchPath, `${JSON.stringify({
      manifest_path: backup.manifestPath,
      backup_directory: backup.backupDirectory,
    }, null, 2)}\n`);
    await launchApp();
    return {
      changed: true,
      backup,
      changes: patched.changes,
      inspection: finalInspection,
      gatekeeper: gatekeeperAfter,
    };
  } catch (error) {
    if (staged != null) {
      await rm(staged.temporaryArchive, { force: true });
      if (staged.temporaryPlist != null) {
        await rm(staged.temporaryPlist, { force: true });
      }
    }
    await restoreBackupFiles(backup);
    await verifyRestoredHashes(backup.manifest);
    backup.manifest.status = 'failed-restored';
    backup.manifest.failure = error instanceof Error ? error.message : String(error);
    backup.manifest.restored_at = new Date().toISOString();
    await writeManifest(backup);
    throw new Error(localize(
      `The patch failed and all backed-up App files were restored. ${backup.manifest.failure}`,
      `补丁失败，已恢复修改前备份的全部 App 文件。${backup.manifest.failure}`,
    ));
  }
}

async function restoreOfficialDefaults() {
  const currentInspection = await inspectArchive();
  const metadata = await appMetadata();
  if (
    metadata.signatureKind === 'official-openai'
    && featureDefinitions.every((feature) => currentInspection.states[feature.id] === 'default')
  ) {
    return {
      changed: false,
      inspection: currentInspection,
      message: localize('The App is already at the official default state.', '当前已经是官方默认状态。'),
    };
  }

  const baseline = await findOfficialBaseline(metadata);
  if (baseline == null) {
    const fallbackResult = await applyDesiredStates(
      Object.fromEntries(featureDefinitions.map((feature) => [feature.id, 'default'])),
      'default-ad-hoc-fallback',
    );
    return { ...fallbackResult, defaultFallback: true };
  }

  const desiredStates = Object.fromEntries(featureDefinitions.map((feature) => [feature.id, 'default']));
  if (dryRun) {
    return { changed: false, dryRun: true, inspection: currentInspection, baseline };
  }
  const backup = await createBackup({
    action: 'restore-official-defaults',
    desiredStates,
    inspection: currentInspection,
    metadata,
  });
  backup.manifest.official_baseline_manifest = baseline.manifestPath;

  await quitApp();
  try {
    for (const key of Object.keys(baseline.manifest.backup_files)) {
      await atomicRestore(
        baseline.manifest.backup_files[key],
        currentPaths[key],
        baseline.manifest.original_modes[key],
      );
    }
    for (const key of Object.keys(baseline.manifest.backup_files)) {
      const actual = await sha256File(currentPaths[key]);
      if (actual !== baseline.manifest.original_hashes[key]) {
        throw new Error(localize(
          `Official baseline SHA-256 verification failed for ${key}.`,
          `官方默认基线 ${key} SHA-256 验证失败。`,
        ));
      }
    }
    const finalInspection = await inspectArchive();
    if (!featureDefinitions.every((feature) => finalInspection.states[feature.id] === 'default')) {
      throw new Error(localize(
        'Feature state is not default after restoration.',
        '恢复后功能状态不是默认值。',
      ));
    }
    const verification = await signAndVerify({ patched: false });
    if (!verification.ok) {
      throw new Error(localize(
        `Restored App verification failed: ${verification.output}`,
        `官方文件恢复验证失败：${verification.output}`,
      ));
    }
    const metadataAfter = await appMetadata();
    const signatureAfter = metadataAfter.signature;
    const gatekeeperAfter = metadataAfter.gatekeeper;
    if (isMac && (!gatekeeperAfter.ok || signatureKind(signatureAfter, gatekeeperAfter) !== 'official-openai')) {
      throw new Error(localize(
        `Official Gatekeeper state was not restored: ${gatekeeperAfter.output}`,
        `官方 Gatekeeper 状态恢复失败：${gatekeeperAfter.output}`,
      ));
    }
    await recordPostHashes(backup.manifest);
    backup.manifest.status = 'restored-official-defaults';
    backup.manifest.applied_at = new Date().toISOString();
    backup.manifest.post_state = {
      feature_states: finalInspection.states,
      signature_kind: isMac ? 'official-openai' : 'restored-original-windows',
      gatekeeper_accepted: isMac ? true : null,
    };
    backup.manifest.validation = {
      asar_integrity: 'verified',
      electron_asar_integrity: isMac ? 'verified' : 'original-executable-restored',
      platform_verify: verification.output || 'valid on disk',
      gatekeeper_output: gatekeeperAfter.output,
    };
    await writeFile(join(backup.backupDirectory, 'signature-after.txt'), `${signatureAfter.output}\n`);
    await writeFile(join(backup.backupDirectory, 'gatekeeper-after.txt'), `${gatekeeperAfter.output}\n`);
    await writeManifest(backup);
    await launchApp();
    return { changed: true, backup, inspection: finalInspection, restoredOfficial: true };
  } catch (error) {
    await restoreBackupFiles(backup);
    await verifyRestoredHashes(backup.manifest);
    backup.manifest.status = 'failed-restored';
    backup.manifest.failure = error instanceof Error ? error.message : String(error);
    backup.manifest.restored_at = new Date().toISOString();
    await writeManifest(backup);
    throw new Error(localize(
      `Default restoration failed; the pre-operation state was restored. ${backup.manifest.failure}`,
      `恢复默认值失败，已恢复操作前状态。${backup.manifest.failure}`,
    ));
  }
}

async function restoreFromManifest(manifestPath) {
  const resolvedManifestPath = resolve(manifestPath);
  const targetManifest = JSON.parse(await readFile(resolvedManifestPath, 'utf8'));
  const metadata = await appMetadata();
  if (
    (targetManifest.platform ?? 'darwin') !== platform
    || targetManifest.app_version !== metadata.appVersion
    || targetManifest.bundle_version !== metadata.bundleVersion
  ) {
    throw new Error(localize(
      'The rollback manifest does not match the current App version.',
      '回滚 manifest 与当前 App 版本不一致。',
    ));
  }
  const inspection = await inspectArchive();
  const desiredStates = targetManifest.pre_state?.feature_states ?? {};
  if (dryRun) {
    return {
      changed: false,
      dryRun: true,
      inspection,
      restoreManifestPath: resolvedManifestPath,
      restoreTargetStates: desiredStates,
    };
  }
  const safetyBackup = await createBackup({
    action: `rollback-${basename(dirname(resolve(manifestPath)))}`,
    desiredStates,
    inspection,
    metadata,
  });
  safetyBackup.manifest.rollback_source_manifest = resolvedManifestPath;

  await quitApp();
  try {
    for (const key of Object.keys(targetManifest.backup_files)) {
      if (currentPaths[key] == null) {
        throw new Error(localize(
          `Rollback manifest contains an unsupported path key for this platform: ${key}`,
          `回滚 manifest 包含当前平台不支持的路径键：${key}`,
        ));
      }
      await atomicRestore(
        targetManifest.backup_files[key],
        currentPaths[key],
        targetManifest.original_modes[key],
      );
    }
    await verifyRestoredHashes(targetManifest);
    const verification = await signAndVerify({ patched: false });
    if (!verification.ok) {
      throw new Error(localize(
        `Rollback verification failed: ${verification.output}`,
        `回滚后的验证失败：${verification.output}`,
      ));
    }
    const finalInspection = await inspectArchive();
    await recordPostHashes(safetyBackup.manifest);
    safetyBackup.manifest.status = 'rollback-applied';
    safetyBackup.manifest.applied_at = new Date().toISOString();
    safetyBackup.manifest.post_state = { feature_states: finalInspection.states };
    safetyBackup.manifest.validation = {
      asar_integrity: 'verified',
      electron_asar_integrity: isMac ? 'verified' : 'restored-from-manifest',
      platform_verify: verification.output || 'valid on disk',
    };
    await writeManifest(safetyBackup);
    await launchApp();
    return { changed: true, backup: safetyBackup, inspection: finalInspection };
  } catch (error) {
    await restoreBackupFiles(safetyBackup);
    await verifyRestoredHashes(safetyBackup.manifest);
    safetyBackup.manifest.status = 'failed-restored';
    safetyBackup.manifest.failure = error instanceof Error ? error.message : String(error);
    safetyBackup.manifest.restored_at = new Date().toISOString();
    await writeManifest(safetyBackup);
    throw error;
  }
}

async function currentStatus() {
  const [inspection, metadata] = await Promise.all([inspectArchive(), appMetadata()]);
  return { inspection, metadata };
}

function printStatus(status) {
  const separator = localize(':', '：');
  console.log('');
  console.log(`${localize('ChatGPT/Codex App', 'ChatGPT/Codex App')}${separator} ${appPath}`);
  console.log(`${localize('Platform', '平台')}${separator} ${isMac ? 'macOS' : 'Windows (experimental)'}`);
  console.log(`${localize('Version', '版本')}${separator} ${status.metadata.appVersion} (${status.metadata.bundleVersion})`);
  console.log(`${localize('Signature', '签名')}${separator} ${status.metadata.signatureKind}`);
  if (isWindows) {
    console.log(localize(
      'Warning: Windows support is experimental and has not been verified on a real Windows installation.',
      '警告：Windows 支持仍为实验性，尚未在真实 Windows 安装中验证。',
    ));
  }
  for (const feature of featureDefinitions) {
    const state = status.inspection.states[feature.id];
    const match = currentMatch(status.inspection, feature);
    console.log(`${feature.number}. ${featureText(feature, 'shortLabel')}${separator} ${stateText(state)}${match == null ? '' : ` [${match.path}]`}`);
  }
  console.log('');
}

function desiredStatesForAction(action, inspection) {
  if (action === 'feature1') {
    return { ...inspection.states, 'new-models': 'added' };
  }
  if (action === 'feature2') {
    return { ...inspection.states, 'api-key-fast': 'added' };
  }
  if (action === 'all') {
    return Object.fromEntries(featureDefinitions.map((feature) => [feature.id, 'added']));
  }
  if (action === 'default') {
    return Object.fromEntries(featureDefinitions.map((feature) => [feature.id, 'default']));
  }
  throw new Error(localize(`Unknown action: ${action}`, `未知操作：${action}`));
}

async function executeAction(action) {
  const inspection = await inspectArchive();
  if (action === 'default') {
    return restoreOfficialDefaults();
  }
  return applyDesiredStates(desiredStatesForAction(action, inspection), action);
}

function printResult(result) {
  const separator = localize(':', '：');
  if (result.defaultFallback) {
    console.log(localize(
      'Warning: no same-version official baseline was found. Only the default feature expressions were restored; platform signing/integrity state may remain modified.',
      '警告：未找到同版本官方基线，只能恢复两项功能的默认逻辑；平台签名或完整性状态可能仍被修改。',
    ));
  }
  if (!result.changed) {
    if (result.dryRun) {
      console.log(localize('Dry run complete; no files were modified.', 'Dry-run 完成，未修改任何文件。'));
      if (result.baseline != null) {
        console.log(`${localize('Official baseline', '官方默认基线')}${separator} ${result.baseline.manifestPath}`);
      }
      if (result.restoreManifestPath != null) {
        console.log(`${localize('Rollback source', '回滚来源')}${separator} ${result.restoreManifestPath}`);
        console.log(`${localize('Rollback target state', '回滚目标状态')}${separator} ${JSON.stringify(result.restoreTargetStates)}`);
      }
      if (result.changes != null) {
        console.log(JSON.stringify(result.changes, null, 2));
      }
      return;
    }
    console.log(result.message ?? localize('Nothing to do.', '无需修改。'));
    return;
  }
  console.log(localize('Operation complete.', '操作完成。'));
  if (result.backup != null) {
    console.log(`${localize('Backup directory', '备份目录')}${separator} ${result.backup.backupDirectory}`);
    console.log(`Manifest${separator} ${result.backup.manifestPath}`);
    console.log(`${localize('Exact rollback', '精确回滚')}${separator} ${result.backup.manifest.rollback_command}`);
  }
  if (isMac && result.gatekeeper != null && !result.gatekeeper.ok) {
    console.log(localize(
      'Gatekeeper: rejected (expected for a local ad-hoc signature).',
      'Gatekeeper：rejected（本地 ad-hoc 签名的预期结果）',
    ));
  }
  if (isWindows) {
    console.log(localize(
      'Windows warning: the executable signature is invalidated when the Electron integrity fuse is changed. Use the manifest rollback to restore the original executable.',
      'Windows 警告：修改 Electron 完整性 fuse 会使可执行文件签名失效；请使用 manifest 回滚恢复原始可执行文件。',
    ));
  }
}

async function interactiveMain() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const status = await currentStatus();
      printStatus(status);
      console.log(localize('Choose an action:', '请选择操作：'));
      console.log(localize('1. Enable feature 1', '1. 添加功能 1'));
      console.log(localize('2. Enable feature 2', '2. 添加功能 2'));
      console.log(localize('3. Enable both features', '3. 添加全部功能'));
      console.log(localize('4. Restore defaults', '4. 改为默认值'));
      console.log(localize('q. Quit', 'q. 退出'));
      const answer = (await rl.question('> ')).trim().toLowerCase();
      if (answer === 'q') {
        console.log(localize('Exited without further changes.', '已退出，未进行其他操作。'));
        return;
      }
      const action = ({ 1: 'feature1', 2: 'feature2', 3: 'all', 4: 'default' })[answer];
      if (action == null) {
        console.log(localize(
          'Invalid option. Enter 1, 2, 3, 4, or q.',
          '无效选项，请输入 1、2、3、4 或 q。',
        ));
        continue;
      }
      const desired = desiredStatesForAction(action, status.inspection);
      console.log(localize('Target state:', '目标状态：'));
      const separator = localize(':', '：');
      for (const feature of featureDefinitions) {
        console.log(`- ${featureText(feature, 'shortLabel')}${separator} ${stateText(desired[feature.id])}`);
      }
      const confirmation = assumeYes
        ? 'y'
        : (await rl.question(localize('Continue? [y/N] ', '确认执行？[y/N] '))).trim().toLowerCase();
      if (!['y', 'yes'].includes(confirmation)) {
        console.log(localize('Cancelled.', '已取消。'));
        continue;
      }
      const result = await executeAction(action);
      printResult(result);
      if (result.changed && !noQuit) {
        return;
      }
    }
  } finally {
    rl.close();
  }
}

function printHelp() {
  console.log(localize(
    `ChatGPT/Codex App Feature Patcher ${toolVersion}\n\nUsage:\n  ./scripts/chatgpt_app_feature_patcher.mjs [options]\n\nOptions:\n  --status                    Show current state without modifying files\n  --set feature1|feature2|all|default\n  --dry-run                   Preview changes only\n  --yes                       Confirm a non-interactive write\n  --lang en|zh-CN             Output language (default: en)\n  --app <path>                macOS .app path or Windows .exe/directory\n  --resources <path>          Override the Electron resources directory\n  --no-quit                   Do not stop or relaunch the App\n  --no-launch                 Do not relaunch after a write\n  --restore-manifest <path>   Restore an exact backup manifest\n  --version                   Print tool version\n  --help                      Show this help\n\nWindows support is experimental and unverified.`,
    `ChatGPT/Codex App 功能补丁工具 ${toolVersion}\n\n用法：\n  ./scripts/chatgpt_app_feature_patcher.zh-CN.mjs [选项]\n\n选项：\n  --status                    只显示当前状态\n  --set feature1|feature2|all|default\n  --dry-run                   只预演，不修改文件\n  --yes                       确认非交互写入\n  --lang en|zh-CN             输出语言（默认英文）\n  --app <路径>                macOS .app 或 Windows .exe/目录\n  --resources <路径>          覆盖 Electron resources 目录\n  --no-quit                   不退出或重启 App\n  --no-launch                 写入后不重启 App\n  --restore-manifest <路径>   按 manifest 精确回滚\n  --version                   显示工具版本\n  --help                      显示帮助\n\nWindows 支持仍为实验性且尚未实测。`,
  ));
}

async function main() {
  if (hasArgument('--help') || hasArgument('-h')) {
    printHelp();
    return;
  }
  if (hasArgument('--version') || hasArgument('-V')) {
    console.log(toolVersion);
    return;
  }
  const restoreManifest = argumentValue('--restore-manifest');
  if (restoreManifest != null) {
    printResult(await restoreFromManifest(restoreManifest));
    return;
  }

  if (hasArgument('--status')) {
    printStatus(await currentStatus());
    return;
  }

  const action = argumentValue('--set');
  if (action != null) {
    if (!['feature1', 'feature2', 'all', 'default'].includes(action)) {
      throw new Error(localize(
        '--set only accepts feature1, feature2, all, or default.',
        '--set 仅支持 feature1、feature2、all 或 default。',
      ));
    }
    if (!assumeYes && !dryRun) {
      throw new Error(localize(
        'Non-interactive writes require --yes, or use --dry-run.',
        '非交互执行必须同时使用 --yes，或使用 --dry-run。',
      ));
    }
    printResult(await executeAction(action));
    return;
  }

  await interactiveMain();
}

export { buildPatchedBuffers, featureDefinitions, inspectArchive, normalizeLanguage };

if (process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`${localize('Error:', '错误：')} ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
