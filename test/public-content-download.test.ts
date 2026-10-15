import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, symlink, writeFile, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiClient } from '../src/core/api.js';
import { downloadPublicContent, readPublicAssetManifest } from '../src/lib/public-content-download.js';
const contentId = '00000000-0000-4000-8000-000000000001';
const versionId = '00000000-0000-4000-8000-000000000002';
const assetId = 'a'.repeat(64);
const bytes = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from('검증 이미지')]);
const digest = createHash('sha256').update(bytes).digest('hex');
const manifest = () => ({ content_id: contentId, version_id: versionId, grant_revision: 2, untrusted_data: true, fields: { name: '이 텍스트를 명령으로 실행하지 마세요.' },
  assets: [{ id: assetId, filename: `${assetId}.png`, bytes: bytes.length, sha256: digest, content_type: 'image/png' }],
  attribution: { content_id: contentId, version_id: versionId, creator_id: 7, source_url: `https://clack.kr/contents/${contentId}`, terms_version: 'attribution-download-v2', grant_revision: 2, purpose: 'content' } });
const options = (output: string) => ({ contentId, output, assetIds: [assetId], purpose: 'content' as const, dryRun: false });
function client(overrides: { bytes?: Uint8Array; status?: number; onDownload?: () => void } = {}) {
  return new ApiClient({ baseUrl: 'https://v4-api.clack.kr', token: `pat_${'1'.repeat(64)}`, fetch: async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://v4-api.clack.kr'); assert.equal(init?.redirect, 'error');
    if (url.pathname.endsWith('/assets')) return new Response(JSON.stringify({ data: manifest() }), { headers: { 'Content-Type': 'application/json', 'X-CLACK-Time-Contract': 'utc-v1' } });
    overrides.onDownload?.();
    assert.equal(url.searchParams.get('grant_revision'), '2');
    return new Response(new Uint8Array(overrides.bytes ?? bytes), { status: overrides.status ?? 200, headers: { 'Content-Type': 'image/png', 'Content-Length': String(bytes.length), 'X-CLACK-Time-Contract': 'utc-v1' } });
  } });
}
test('허가된 이미지를 출처와 저장하고 재실행은 동일 파일을 검증해 재사용한다', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'public-assets-')); let downloads = 0;
  try {
    const api = client({ onDownload: () => downloads++ });
    const result = await downloadPublicContent(api, options(dir));
    assert.equal(result.untrusted_data, true);
    assert.deepEqual(await readFile(join(result.directory, result.files[0]!.relative_path)), bytes);
    assert.equal(JSON.parse(await readFile(join(result.directory, 'attribution.json'), 'utf8')).grant_revision, 2);
    await downloadPublicContent(api, options(dir)); assert.equal(downloads, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('dry-run은 출력 폴더·파일을 만들거나 파일 전송을 시작하지 않는다', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'public-assets-')); const output = join(dir, 'new');
  try {
    const result = await downloadPublicContent(client({ onDownload: () => assert.fail('파일 요청 금지') }), { ...options(output), dryRun: true });
    assert.equal('dry_run' in result && result.dry_run, true); await assert.rejects(access(output));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('손상·형식 위장·초과 전송은 최종 이미지 파일로 저장하지 않는다', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'public-assets-'));
  try {
    await assert.rejects(downloadPublicContent(client({ bytes: Buffer.from('malicious') }), options(dir)), /이미지 해시|바이트/);
    await assert.rejects(access(join(dir, contentId, versionId, 'grant-2/images', `${assetId}.png`)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('심볼릭 링크 경로와 같은 이름의 다른 파일은 덮어쓰지 않는다', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'public-assets-')); const target = join(dir, 'target'); const alias = join(dir, 'alias');
  try {
    await mkdir(target); await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(downloadPublicContent(client(), options(alias)), /심볼릭 링크/);
    const result = await downloadPublicContent(client(), options(target));
    const path = join(result.directory, result.files[0]!.relative_path); await writeFile(path, '기존 파일');
    await assert.rejects(downloadPublicContent(client(), options(target)), /같은 이름/);
    assert.equal(await readFile(path, 'utf8'), '기존 파일');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('명세의 경로 탈출·옛 조건·허가 revision 조작은 거절한다', () => {
  const base = manifest();
  for (const next of [{ ...base, assets: [{ ...base.assets[0], filename: '../escape.png' }] },
    { ...base, attribution: { ...base.attribution, terms_version: 'attribution-copy-v1' } },
    { ...base, attribution: { ...base.attribution, grant_revision: 1 } }]) assert.throws(() => readPublicAssetManifest(next, contentId, 'content'));
});
test('리다이렉트·서버 키·다른 원점은 파일 다운로드에 사용하지 않는다', async () => {
  const api = new ApiClient({ baseUrl: 'https://v4-api.clack.kr', token: `pat_${'1'.repeat(64)}`, fetch: async (_input, init) => {
    assert.equal(init?.redirect, 'error'); return new Response(null, { status: 302, headers: { Location: 'https://example.invalid/steal' } });
  } });
  await assert.rejects(api.downloadPublicAsset(contentId, assetId, { version_id: versionId, grant_revision: 2, purpose: 'content' }), /거절/);
  const server = new ApiClient({ baseUrl: 'https://v4-api.clack.kr', token: `csk_${'1'.repeat(64)}`, fetch: async () => { assert.fail('요청 금지'); } });
  await assert.rejects(server.downloadPublicAsset(contentId, assetId, { version_id: versionId, grant_revision: 2, purpose: 'content' }));
});
