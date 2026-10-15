import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join, parse as parsePath, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { ApiClient } from '../core/api.js';
import { CliError } from '../core/errors.js';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_BATCH_BYTES = 32 * 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
const assetSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), filename: z.string().max(80), content_type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  bytes: z.number().int().min(1).max(MAX_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/), ai_generated: z.boolean().optional() });
const manifestSchema = z.object({ content_id: z.uuid(), version_id: z.uuid(), grant_revision: z.number().int().nonnegative(),
  assets: z.array(assetSchema).max(24), fields: z.record(z.string(), z.unknown()), untrusted_data: z.literal(true),
  attribution: z.object({ content_id: z.uuid(), version_id: z.uuid(), creator_id: z.number().int().positive(), source_url: z.string().url(),
    terms_version: z.enum(['owner', 'attribution-download-v2']), grant_revision: z.number().int().nonnegative(), purpose: z.enum(['content', 'template']) }) });
export type PublicAssetManifest = z.infer<typeof manifestSchema>;

export function readPublicAssetManifest(value: unknown, contentId: string, purpose: 'content' | 'template'): PublicAssetManifest {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw new CliError('공개 자산 명세를 확인할 수 없습니다.', 'INVALID_RESPONSE');
  const manifest = parsed.data;
  if (manifest.content_id !== contentId || manifest.attribution.content_id !== contentId || manifest.attribution.version_id !== manifest.version_id
    || manifest.attribution.grant_revision !== manifest.grant_revision || manifest.attribution.purpose !== purpose
    || new Set(manifest.assets.map(asset => asset.id)).size !== manifest.assets.length
    || manifest.assets.some(asset => asset.filename !== `${asset.id}.${extension[asset.content_type]}`)) throw new CliError('공개 자산의 버전·식별자가 일치하지 않습니다.', 'INVALID_RESPONSE');
  return manifest;
}
/** 기존 파일·상위 디렉터리의 심볼릭 링크를 거부한다. 새 디렉터리는 개인 쓰기 권한으로 만든다. */
async function safeDirectory(path: string): Promise<void> {
  const absolute = resolve(path); const root = parsePath(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CliError('출력 경로에 심볼릭 링크나 일반 파일이 있습니다.', 'UNSAFE_OUTPUT_PATH');
  }
}
async function existingMatches(path: string, expectedHash: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_BATCH_BYTES) throw new CliError('출력 파일이 안전한 일반 파일이 아닙니다.', 'UNSAFE_OUTPUT_PATH');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (hash(await file.readFile()) !== expectedHash) throw new CliError('같은 이름의 다른 파일이 있습니다. 새 출력 폴더를 지정하세요.', 'OUTPUT_CONFLICT');
      return true;
    } finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
/** 검증이 끝난 임시 파일을 하드 링크로 게시해 기존 파일을 원자적으로 보호한다. */
async function writeVerified(path: string, bytes: Uint8Array): Promise<void> {
  const expected = hash(bytes);
  if (await existingMatches(path, expected)) return;
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes); await handle.sync(); await handle.close();
    try { await link(temp, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !await existingMatches(path, expected)) throw error; }
  } finally { await handle.close().catch(() => undefined); await unlink(temp).catch(() => undefined); }
}
const magic = (bytes: Buffer, mime: string) => mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP';
async function readAsset(response: Response, asset: PublicAssetManifest['assets'][number]): Promise<Buffer> {
  if (response.headers.get('content-type') !== asset.content_type || Number(response.headers.get('content-length')) !== asset.bytes || !response.body) {
    await response.body?.cancel(); throw new CliError('다운로드 형식이나 크기가 명세와 다릅니다.', 'ASSET_MISMATCH');
  }
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > asset.bytes || length > MAX_BYTES) throw new CliError('이미지 크기가 상한을 초과했습니다.', 'ASSET_MISMATCH');
      chunks.push(Buffer.from(chunk.value));
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = Buffer.concat(chunks, length);
  if (length !== asset.bytes || hash(bytes) !== asset.sha256 || !magic(bytes, asset.content_type)) throw new CliError('이미지 해시·바이트·실제 형식이 일치하지 않습니다.', 'ASSET_MISMATCH');
  return bytes;
}

export async function downloadPublicContent(api: ApiClient, input: { contentId: string; assetIds: string[]; output: string; purpose: 'content' | 'template'; dryRun: boolean }) {
  if (!input.output.trim() || !input.assetIds.length || input.assetIds.length > 24 || new Set(input.assetIds).size !== input.assetIds.length
    || input.assetIds.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new CliError('저장할 자산 ID와 출력 폴더를 지정하세요.', 'VALIDATION_ERROR');
  const manifest = readPublicAssetManifest((await api.request('GET', `/v4/creator/public-contents/${input.contentId}/assets`, { query: { purpose: input.purpose } })).data, input.contentId, input.purpose);
  const selected = input.assetIds.map(id => {
    const asset = manifest.assets.find(asset => asset.id === id);
    if (!asset) throw new CliError('현재 허가에 없는 자산 ID입니다.', 'ASSET_NOT_ALLOWED');
    return asset;
  });
  if (selected.reduce((sum, asset) => sum + asset.bytes, 0) > MAX_BATCH_BYTES) throw new CliError('한 번에 32 MiB 이하로 선택하세요.', 'ASSET_BATCH_TOO_LARGE');
  const directory = join(resolve(input.output), manifest.content_id, manifest.version_id, `grant-${manifest.grant_revision}`);
  const files = selected.map(asset => ({ ...asset, relative_path: `images/${asset.filename}` }));
  if (input.dryRun) return { dry_run: true, directory, files, attribution: manifest.attribution, untrusted_data: true };
  await safeDirectory(directory); await safeDirectory(join(directory, 'images'));
  // 중단된 다운로드에도 이미 받은 파일의 출처가 남게 명세를 먼저 쓴다. 전체 완료 여부는 파일별 해시로 검증한다.
  const serialize = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  await writeVerified(join(directory, 'attribution.json'), serialize({ ...manifest.attribution, untrusted_data: true }));
  await writeVerified(join(directory, 'public-data.json'), serialize({ untrusted_data: true, fields: manifest.fields }));
  for (const asset of selected) {
    const path = join(directory, 'images', asset.filename);
    if (await existingMatches(path, asset.sha256)) continue;
    const response = await api.downloadPublicAsset(manifest.content_id, asset.id, { version_id: manifest.version_id, grant_revision: manifest.grant_revision, purpose: input.purpose });
    await writeVerified(path, await readAsset(response, asset));
  }
  return { directory, files, attribution: manifest.attribution, untrusted_data: true };
}
