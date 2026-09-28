import { inspectAuthoringSemantics } from '../vendor/clack-api-v4-contracts/authoring-semantics.mjs';
import { createHash } from 'node:crypto';
import { lstat, open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { unzipSync, zipSync } from 'fflate';
import { parseDocument } from 'yaml';
import { CliError } from '../core/errors.js';
import skillSchema from '../vendor/clack-api-v4-contracts/schemas/clack-skill.v1.schema.json' with { type: 'json' };
import formSchema from '../vendor/clack-api-v4-contracts/schemas/authoring-form.v1.schema.json' with { type: 'json' };
import contentSchema from '../vendor/clack-api-v4-contracts/schemas/clack-content.v1.schema.json' with { type: 'json' };

const MAX_ZIP = 10 * 1024 * 1024;
const MAX_EXPANDED = 30 * 1024 * 1024;
const MAX_FILES = 500;
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(contentSchema);
const validateManifest = ajv.compile(skillSchema);
const validateForm = new Ajv2020({ allErrors: true, strict: false }).compile(formSchema);

type Manifest = Record<string, unknown> & { name: string; version: string; type: string };
export type PreparedSkillPackage = {
  bytes: Buffer;
  sha256: string;
  manifest: Manifest;
  file_count: number;
  total_bytes: number;
};

function invalid(message: string): never { throw new CliError(message, 'SKILL_PACKAGE_INVALID'); }
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function json(bytes: Uint8Array, max: number, label: string): Record<string, unknown> {
  if (bytes.length > max) invalid(`${label} 크기 제한을 초과했습니다.`);
  try { const parsed: unknown = JSON.parse(textDecoder.decode(bytes)); if (object(parsed)) return parsed; }
  catch { /* 파일 내용은 오류에 노출하지 않는다. */ }
  return invalid(`${label}은 UTF-8 JSON 객체여야 합니다.`);
}

async function readRegular(path: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) invalid('스킬 패키지에는 일반 파일만 허용됩니다.');
    return await handle.readFile();
  } catch (error) {
    if (error instanceof CliError) throw error;
    return invalid('스킬 파일을 안전하게 읽을 수 없습니다.');
  } finally { await handle?.close(); }
}

export function skillPathAllowed(path: string): boolean {
  if (!path || path.length > 220 || path.normalize('NFC') !== path || /[\p{C}\s\\%?#:]/u.test(path)
    || path.startsWith('/') || path.startsWith('__')) return false;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..'
    || (part.startsWith('.') && !(parts[0] === 'runtime' && part === '.clack' && parts.indexOf(part) === 1)))) return false;
  if (parts.includes('scripts') || /\.(?:sh|bash|zsh|fish|bat|cmd|ps1|exe|dll|so|dylib|wasm|py|rb|php|jar)$/i.test(path)) return false;
  return true;
}

async function collectFiles(directory: string): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  let totalBytes = 0;
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (!skillPathAllowed(path)) invalid(`허용되지 않는 패키지 경로: ${path}`);
      if (entry.isSymbolicLink() || !(entry.isDirectory() || entry.isFile())) invalid(`일반 파일·폴더만 허용됩니다: ${path}`);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (Object.keys(files).length >= MAX_FILES) invalid('스킬 파일 수가 500개를 초과했습니다.');
      const data = await readRegular(join(directory, path));
      totalBytes += data.length;
      if (totalBytes > MAX_EXPANDED) invalid('스킬 압축 해제 용량이 30 MiB를 초과했습니다.');
      files[path] = data;
    }
  }
  await walk('');
  return files;
}

function inspectZip(bytes: Uint8Array, expectedDirectory?: string): Omit<PreparedSkillPackage, 'bytes' | 'sha256'> {
  if (!bytes.length || bytes.length > MAX_ZIP) invalid('스킬 ZIP은 비어 있지 않은 10 MiB 이하 파일이어야 합니다.');
  const seen = new Set<string>();
  let entries = 0;
  let totalBytes = 0;
  let extracted: Record<string, Uint8Array>;
  try {
    extracted = unzipSync(bytes, { filter(entry) {
      entries++;
      if (entries > MAX_FILES) invalid('스킬 파일 수가 500개를 초과했습니다.');
      const path = entry.name.endsWith('/') ? entry.name.slice(0, -1) : entry.name;
      if (!skillPathAllowed(path) || seen.has(path.toLowerCase())) invalid(`허용되지 않는 ZIP 경로: ${path}`);
      seen.add(path.toLowerCase());
      if (entry.name.endsWith('/')) return false;
      totalBytes += entry.originalSize;
      if (totalBytes > MAX_EXPANDED) invalid('스킬 압축 해제 용량이 30 MiB를 초과했습니다.');
      return true;
    } });
  } catch (error) {
    if (error instanceof CliError) throw error;
    return invalid('ZIP 구조를 읽을 수 없습니다.');
  }
  const markdown = extracted['SKILL.md'];
  const manifestBytes = extracted['clack.skill.json'];
  if (!markdown || !manifestBytes) invalid('루트 SKILL.md와 clack.skill.json이 필요합니다.');
  if (markdown.length > 20 * 1024) invalid('SKILL.md는 20 KiB 이하여야 합니다.');
  let frontmatter: string;
  try {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(textDecoder.decode(markdown));
    if (!match) invalid('SKILL.md의 YAML frontmatter를 확인하세요.');
    frontmatter = match[1]!;
  } catch { return invalid('SKILL.md는 UTF-8 텍스트여야 합니다.'); }
  const document = parseDocument(frontmatter, { version: '1.2', uniqueKeys: true, merge: false });
  if (document.errors.length || document.warnings.length || /(?:^|\n)\s*allowed-tools\s*:/i.test(frontmatter)) {
    invalid('SKILL.md frontmatter에 잘못된 값 또는 allowed-tools가 있습니다.');
  }
  let front: unknown;
  try { front = document.toJS({ maxAliasCount: 0 }); } catch { return invalid('SKILL.md frontmatter를 확인하세요.'); }
  if (!object(front) || typeof front.name !== 'string' || typeof front.description !== 'string'
    || !front.description.length || front.description.length > 1024) invalid('SKILL.md의 name·description을 확인하세요.');
  const manifest = json(manifestBytes, 64 * 1024, 'clack.skill.json');
  if (!validateManifest(manifest)) invalid('clack.skill.json이 공개 스킬 스키마와 일치하지 않습니다.');
  if (manifest.name !== front.name || expectedDirectory && manifest.name !== expectedDirectory && manifest.version !== expectedDirectory
    || object(front.metadata) && front.metadata.version !== undefined && front.metadata.version !== manifest.version) {
    invalid('스킬 디렉터리·SKILL.md·매니페스트의 이름 또는 버전이 다릅니다.');
  }
  const file = (path: unknown, max?: number): Uint8Array => {
    if (typeof path !== 'string' || !skillPathAllowed(path) || !extracted[path]) invalid('매니페스트에 선언한 파일이 없습니다.');
    const data = extracted[path]!;
    if (max && data.length > max) invalid('선언한 파일의 크기 제한을 초과했습니다.');
    return data;
  };
  const display = manifest.display as Record<string, unknown>;
  if (display.icon) file(display.icon);
  for (const screenshot of display.screenshots as string[] | undefined ?? []) file(screenshot);
  const authoring = manifest.authoring as Record<string, unknown>;
  const output = manifest.output as Record<string, unknown>;
  for (const reference of authoring.references as string[] | undefined ?? []) file(reference, 64 * 1024);
  if (manifest.type === 'template' || manifest.type === 'tool') {
    const form = json(file(authoring.form, 64 * 1024), 64 * 1024, '제작 폼');
    if (!validateForm(form)) invalid('제작 폼이 공개 스키마와 일치하지 않습니다.');
    const semanticErrors = inspectAuthoringSemantics(manifest, form);
    if (semanticErrors.length) invalid(semanticErrors.map((error) => `${error.path}: ${error.message}`).join(' / '));
    const template = output.template as Record<string, unknown>;
    if (template.root !== 'runtime' || typeof template.entry !== 'string') invalid('runtime 템플릿 경로를 확인하세요.');
    file(`runtime/${template.entry}`);
    const runtime = manifest.runtime as Record<string, unknown>;
    for (const profile of runtime.profiles as string[]) file(`runtime/.clack/profiles/${profile}.yaml`, 16 * 1024);
    const examples = Object.keys(extracted).filter((path) => /^examples\/[^/]+\.json$/.test(path));
    if (!examples.length || examples.length > 10) invalid('템플릿 예시는 1~10개 필요합니다.');
    let validateExample: (value: unknown) => boolean;
    try {
      const examplesAjv = new Ajv2020({ allErrors: true, strict: false });
      examplesAjv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      validateExample = examplesAjv.compile(form);
    }
    catch { return invalid('제작 폼 JSON Schema를 확인하세요.'); }
    for (const path of examples) if (!validateExample(json(file(path, 64 * 1024), 64 * 1024, '예시'))) {
      invalid('제작 폼과 예시 데이터가 일치하지 않습니다.');
    }
  }
  return { manifest: manifest as Manifest, file_count: Object.keys(extracted).length, total_bytes: totalBytes };
}

export async function prepareSkillPackage(source: string): Promise<PreparedSkillPackage> {
  const path = resolve(source);
  let info;
  try { info = await lstat(path); } catch { return invalid('스킬 디렉터리 또는 ZIP 파일을 읽을 수 없습니다.'); }
  if (info.isSymbolicLink()) invalid('스킬 경로는 심볼릭 링크일 수 없습니다.');
  let bytes: Buffer;
  if (info.isDirectory()) {
    const files = await collectFiles(path);
    if (!Object.keys(files).length) invalid('스킬 디렉터리가 비어 있습니다.');
    bytes = Buffer.from(zipSync(files, { level: 6, mtime: new Date(2000, 0, 1) }));
  } else if (info.isFile() && extname(path).toLowerCase() === '.zip') bytes = await readRegular(path);
  else return invalid('스킬 디렉터리 또는 ZIP 파일을 지정하세요.');
  const inspected = inspectZip(bytes, info.isDirectory() ? basename(path) : undefined);
  return { bytes, sha256: hash(bytes), ...inspected };
}
