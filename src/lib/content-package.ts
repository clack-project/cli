import { unzipSync } from 'fflate';

const KIB = 1024;
const MAX_FILES = 2000;
const MAX_EXPANDED_BYTES = 150 * 1024 * KIB;
const MAX_MANIFEST_BYTES = 64 * KIB;
const MAX_PUBLIC_CONFIG_BYTES = 32 * KIB;
const MAX_PROFILE_BYTES = 32 * KIB;
const MAX_PRIVATE_CONFIG_BYTES = 256 * KIB;
const PROFILE_PATH = /^\.clack\/profiles\/([a-z][a-z0-9-]{0,31})\.yaml$/;
const PROFILE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SDK_VERSION = /^1(?:\.[0-9]+(?:\.[0-9]+)?)?$/;
const CAPABILITIES = new Set([
  'identity.basic', 'events.track', 'data.viewer', 'data.shared', 'data.creator',
  'identity.profile', 'ai.conversation', 'ai.completion', 'cash.purchase', 'ai.image',
]);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(bytes: Uint8Array): JsonObject | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return isObject(value) ? value : null;
  } catch { return null; }
}

/** 서버 심사 전에 명백한 패키지 오류만 알린다. 경고는 업로드를 차단하지 않는다. */
export function inspectContentPackage(bytes: Uint8Array): string[] {
  const warnings: string[] = [];
  const paths = new Set<string>();
  const profileFiles = new Set<string>();
  let entries = 0;
  let expandedBytes = 0;
  let hasPrivateFiles = false;
  let hasManifest = false;
  let hasIndex = false;
  let manifestTooLarge = false;
  let privateTooLarge = false;
  let profileTooLarge = false;
  let unsafePath = false;
  let unsupportedPrivatePath = false;
  let duplicatePath = false;
  let tooManyFiles = false;
  let tooLargeExpanded = false;
  let files: Record<string, Uint8Array>;

  try {
    files = unzipSync(bytes, { filter(entry) {
      entries++;
      if (entries > MAX_FILES) { tooManyFiles = true; throw new Error('too many files'); }
      const path = entry.name.endsWith('/') ? entry.name.slice(0, -1) : entry.name;
      const key = path.toLocaleLowerCase('en-US');
      if (paths.has(key)) duplicatePath = true;
      paths.add(key);
      if (!path || path.length > 220 || path.normalize('NFC') !== path
        || /[\p{C}\s\\%?#:]/u.test(path) || path.startsWith('/')
        || path.split('/').some((part, index) => !part || part === '.' || part === '..'
          || (part.startsWith('.') && !(index === 0 && part === '.clack')))) unsafePath = true;
      if (path === 'index.html' && !entry.name.endsWith('/') && entry.originalSize > 0) hasIndex = true;
      if (path === 'clack.content.json' && !entry.name.endsWith('/')) {
        hasManifest = true;
        if (entry.originalSize > MAX_MANIFEST_BYTES) manifestTooLarge = true;
      }
      if (path === '.clack' || path.startsWith('.clack/')) {
        hasPrivateFiles = true;
        if (!entry.name.endsWith('/')) {
          const match = PROFILE_PATH.exec(path);
          if (match) {
            profileFiles.add(match[1]!);
            if (entry.originalSize > MAX_PROFILE_BYTES) profileTooLarge = true;
          } else if (path === '.clack/config.private.json') {
            if (entry.originalSize > MAX_PRIVATE_CONFIG_BYTES) privateTooLarge = true;
          } else unsupportedPrivatePath = true;
        }
      }
      expandedBytes += entry.originalSize;
      if (expandedBytes > MAX_EXPANDED_BYTES) tooLargeExpanded = true;
      if (entry.name.endsWith('/')) return false;
      return (path === 'clack.content.json' && entry.originalSize <= MAX_MANIFEST_BYTES)
        || (path === '.clack/config.private.json' && entry.originalSize <= MAX_PRIVATE_CONFIG_BYTES);
    } });
  } catch {
    warnings.push(tooManyFiles ? 'ZIP 파일 수가 서버 제한인 2000개를 초과합니다.' : 'ZIP 구조를 읽을 수 없습니다.');
    return warnings;
  }

  if (duplicatePath) warnings.push('대소문자 구분 없이 중복된 ZIP 경로가 있습니다.');
  if (unsafePath) warnings.push('ZIP에 허용되지 않는 경로가 있습니다.');
  if (tooLargeExpanded) warnings.push('압축 해제 용량이 서버 제한인 150 MiB를 초과합니다.');
  if (!hasIndex) warnings.push('번들 루트에 비어 있지 않은 index.html이 필요합니다.');
  if (!hasManifest && !hasPrivateFiles) return warnings;
  if (!hasManifest) warnings.push('.clack/ 파일이 있지만 루트 clack.content.json이 없습니다.');
  if (manifestTooLarge) warnings.push('clack.content.json이 64 KiB 제한을 초과합니다.');
  if (privateTooLarge) warnings.push('.clack/config.private.json이 256 KiB 제한을 초과합니다.');
  if (profileTooLarge) warnings.push('.clack/profiles/ 파일이 32 KiB 제한을 초과합니다.');
  if (unsupportedPrivatePath) warnings.push('.clack/에는 profiles/{name}.yaml과 config.private.json만 둘 수 있습니다.');

  const manifestBytes = files['clack.content.json'];
  const manifest = manifestBytes ? parseObject(manifestBytes) : null;
  if (hasManifest && !manifestTooLarge && !manifest) warnings.push('clack.content.json은 UTF-8 JSON 객체여야 합니다.');
  if (manifest) {
    if (manifest.manifest_version !== 1 || typeof manifest.sdk !== 'string' || !SDK_VERSION.test(manifest.sdk)
      || !Array.isArray(manifest.capabilities) || !Array.isArray(manifest.profiles)
      || !isObject(manifest.collections) || !isObject(manifest.items) || !isObject(manifest.config)) {
      warnings.push('clack.content.json의 필수 선언 또는 버전 형식을 확인하세요.');
    } else {
      if (manifest.capabilities.some((capability) => typeof capability !== 'string' || !CAPABILITIES.has(capability))
        || new Set(manifest.capabilities).size !== manifest.capabilities.length) {
        warnings.push('capabilities에 알 수 없거나 중복된 권한이 있습니다.');
      }
      const declared = manifest.profiles;
      if (declared.length > 8 || declared.some((name) => typeof name !== 'string' || !PROFILE_NAME.test(name))
        || new Set(declared).size !== declared.length) warnings.push('profiles 이름·개수·중복을 확인하세요.');
      else if (declared.some((name) => !profileFiles.has(name))
        || [...profileFiles].some((name) => !declared.includes(name))) {
        warnings.push('profiles 선언과 .clack/profiles/*.yaml 파일이 일치하지 않습니다.');
      }
      if (Object.hasOwn(manifest.config, 'private')
        || Buffer.byteLength(JSON.stringify(manifest.config), 'utf8') > MAX_PUBLIC_CONFIG_BYTES) {
        warnings.push('공개 config에 private 키가 있거나 32 KiB 제한을 초과합니다.');
      }
    }
    const allowedKeys = new Set(['manifest_version', 'sdk', 'capabilities', 'profiles', 'collections', 'items', 'config', 'built_with']);
    if (Object.keys(manifest).some((key) => !allowedKeys.has(key))) warnings.push('clack.content.json에 공개 계약에 없는 최상위 키가 있습니다.');
  }
  const privateBytes = files['.clack/config.private.json'];
  if (privateBytes && !parseObject(privateBytes)) warnings.push('.clack/config.private.json은 UTF-8 JSON 객체여야 합니다.');
  return warnings;
}
