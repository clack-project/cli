import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { zipSync } from 'fflate';
import { prepareContentFile, putContentFile, registerContentCommands } from '../src/commands/content.js';
import { ApiClient } from '../src/core/api.js';
import type { CommandContext, Runtime } from '../src/core/types.js';
import { parseScopes } from '../src/commands/auth.js';
import { requestTimeContract } from '../src/core/time.js';

const contentId = '00000000-0000-4000-8000-000000000001';
const versionId = '00000000-0000-4000-8000-000000000002';
const manifest = {
  manifest_version: 1, sdk: '1', capabilities: ['identity.basic'], profiles: ['chat'],
  collections: {}, items: {}, config: {},
};
test('콘텐츠 파일 dry-run은 파일 검사만 하고 API에 쓰지 않는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'creator-cli-'));
  try {
    const file = join(dir, '페이지.html');
    await writeFile(file, '<!doctype html><html><body>클랙</body></html>');
    const prepared = await prepareContentFile(file);
    assert.equal(prepared.metadata.content_type, 'text/html');
    assert.equal(prepared.metadata.sha256, createHash('sha256').update(prepared.bytes).digest('hex'));
    const outputs: unknown[] = [];
    const ctx: CommandContext = { api: new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', dryRun: true }), options: { dryRun: true }, output: (value) => outputs.push(value), confirm: async () => { throw new Error('확인 불필요'); } };
    const runtime: Runtime = { action(command, handler) { command.action(async (...values: unknown[]) => { const cmd = values.at(-1) as Command; await handler(ctx, values.slice(0, -2) as string[], cmd.opts()); }); } };
    const program = new Command().exitOverride();
    registerContentCommands(program, runtime);
    await program.parseAsync(['content', 'upload', contentId, file], { from: 'user' });
    assert.equal(outputs.length, 1);
    await assert.rejects(prepareContentFile(join(dir, '.env')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('정적 ZIP은 선언 없이 업로드 가능하고 선언 패키지는 로컬 구조를 경고로 확인한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'creator-cli-package-'));
  const index = new TextEncoder().encode('<!doctype html><html><body>테스트</body></html>');
  try {
    const legacy = join(dir, 'legacy.zip');
    await writeFile(legacy, zipSync({ 'index.html': index }));
    assert.deepEqual((await prepareContentFile(legacy)).warnings, []);

    const valid = join(dir, 'valid.zip');
    await writeFile(valid, zipSync({
      'index.html': index,
      'clack.content.json': new TextEncoder().encode(JSON.stringify(manifest)),
      '.clack/profiles/chat.yaml': new TextEncoder().encode('schema_version: 1\nname: chat\n'),
      '.clack/config.private.json': new TextEncoder().encode('{}'),
    }));
    assert.deepEqual((await prepareContentFile(valid)).warnings, []);

    const invalid = join(dir, 'invalid.zip');
    await writeFile(invalid, zipSync({
      'index.html': index,
      'clack.content.json': new TextEncoder().encode(JSON.stringify({ ...manifest, capabilities: ['unknown.permission'] })),
      '.clack/profiles/other.yaml': new TextEncoder().encode('name: other\n'),
      '.clack/secret.txt': new TextEncoder().encode('비밀 값'),
    }));
    const prepared = await prepareContentFile(invalid);
    assert.equal(prepared.metadata.content_type, 'application/zip');
    assert.ok(prepared.warnings.some((warning) => warning.includes('capabilities')));
    assert.ok(prepared.warnings.some((warning) => warning.includes('profiles 선언')));
    assert.ok(prepared.warnings.some((warning) => warning.includes('.clack/에는')));
    assert.ok(prepared.warnings.every((warning) => !warning.includes('비밀 값')));
    const outputs: unknown[] = [];
    const emitted: string[] = [];
    const ctx: CommandContext = { api: new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', dryRun: true }),
      options: { dryRun: true }, output: (value) => outputs.push(value), confirm: async () => { throw new Error('확인 불필요'); } };
    const runtime: Runtime = { action(command, handler) { command.action(async (...values: unknown[]) => {
      const cmd = values.at(-1) as Command;
      await handler(ctx, values.slice(0, -2) as string[], cmd.opts());
    }); } };
    const program = new Command().exitOverride();
    registerContentCommands(program, runtime);
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { emitted.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try { await program.parseAsync(['content', 'upload', contentId, invalid], { from: 'user' }); }
    finally { process.stderr.write = originalWrite; }
    assert.equal(outputs.length, 1);
    assert.ok(emitted.some((line) => line.includes('패키지 경고: capabilities')));
    assert.ok(emitted.every((line) => !line.includes('비밀 값')));

    const noManifest = join(dir, 'no-manifest.zip');
    await writeFile(noManifest, zipSync({ 'index.html': index, '.clack/config.private.json': new TextEncoder().encode('{}') }));
    assert.ok((await prepareContentFile(noManifest)).warnings.some((warning) => warning.includes('clack.content.json이 없습니다')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('S3 업로드는 임의 주소·체크섬 불일치 차단과 PAT 비전송을 보장한다', async () => {
  const bytes = Buffer.from('<html>테스트</html>');
  const session = { upload_id: versionId,
    upload_url: 'https://clack-creator-content-dev-123456789012-ap-northeast-2.s3.ap-northeast-2.amazonaws.com/_staging/7/upload?signature=test',
    headers: { 'Content-Type': 'text/html', 'x-amz-checksum-sha256': createHash('sha256').update(bytes).digest('base64'), Authorization: '금지' } };
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get('Authorization'), null);
    assert.equal(init?.redirect, 'error');
    return new Response(null, { status: 200 });
  };
  await assert.rejects(putContentFile({ ...session, upload_url: 'https://evil.test/_staging/a' }, bytes, fetcher));
  await assert.rejects(putContentFile(session, Buffer.from('다른 파일'), fetcher));
  assert.equal(calls, 0);
  await putContentFile(session, bytes, fetcher);
  assert.equal(calls, 1);
});
test('크리에이터 약식 scope는 공개 권한을 자동 부여하지 않고 변경도 UTC를 사용한다', () => {
  assert.deepEqual(parseScopes('creator-content'), ['creator-content:read', 'creator-content:write']);
  assert.deepEqual(parseScopes('creator-content:publish'), ['creator-content:publish']);
  assert.deepEqual(parseScopes('skill'), ['skill:read', 'skill:write']);
  assert.deepEqual(parseScopes('skill:publish'), ['skill:publish']);
  assert.deepEqual(parseScopes('platform'), ['platform:read', 'platform:write']);
  assert.deepEqual(parseScopes('platform:read'), ['platform:read']);
  assert.equal(requestTimeContract('POST', `/v4/creator/contents/${contentId}/versions/${versionId}/submit`), 'utc-v1');
  assert.equal(requestTimeContract('POST', `/v4/creator/contents/${contentId}/versions/${versionId}/publish`), 'utc-v1');
});

test('공개·서버 키·공유 문서 명령은 실제 PAT 경로와 확인 절차를 사용한다', async () => {
  const calls: { call: string; body: unknown }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ call: `${init?.method ?? 'GET'} ${url.pathname}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (init?.method === 'DELETE') return new Response(null, { status: 204, headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
    return new Response(JSON.stringify({ data: { ok: true } }), { headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
  };
  const outputs: unknown[] = [];
  const confirmations: string[] = [];
  const ctx: CommandContext = { api: new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', token: `pat_${'a'.repeat(64)}`, fetch: fetcher }),
    options: {}, output: (value) => outputs.push(value), confirm: async (message) => { confirmations.push(message); } };
  const runtime: Runtime = { action(command, handler) { command.action(async (...values: unknown[]) => {
    const cmd = values.at(-1) as Command;
    await handler(ctx, values.slice(0, -2) as string[], cmd.opts());
  }); } };
  const root = `/v4/creator/contents/${contentId}`;
  async function run(...args: string[]) {
    const program = new Command().exitOverride();
    registerContentCommands(program, runtime);
    await program.parseAsync(args, { from: 'user' });
  }
  await run('content', 'publish', contentId, versionId);
  await run('content', 'server-keys', 'list', contentId);
  // 발급·회전은 센터 전용이라 요청 없이 안내 오류만 낸다.
  await assert.rejects(run('content', 'server-keys', 'issue', contentId, '--label', '내 서버', '--scopes', 'data:read, data:write'),
    (error: { code?: string; message?: string }) => error.code === 'SERVER_KEY_CENTER_ONLY' && /크리에이터 센터/.test(error.message ?? ''));
  await assert.rejects(run('content', 'server-keys', 'rotate', contentId, '7', '--grace-seconds', '60'), { code: 'SERVER_KEY_CENTER_ONLY' });
  await run('content', 'server-keys', 'revoke', contentId, '7');
  await run('content', 'shared', 'collections', contentId);
  await run('content', 'shared', 'list', contentId, 'ranking');
  await run('content', 'shared', 'get', contentId, 'ranking', 'entry-1');
  await run('content', 'shared', 'hide', contentId, 'ranking', 'entry-1');
  await run('content', 'shared', 'delete', contentId, 'ranking', 'entry-1');
  assert.deepEqual(calls.map((entry) => entry.call), [
    `POST ${root}/versions/${versionId}/publish`,
    `GET ${root}/server-keys`,
    `DELETE ${root}/server-keys/7`,
    `GET ${root}/shared-document-collections`,
    `GET ${root}/shared-documents/ranking`,
    `GET ${root}/shared-documents/ranking/entry-1`,
    `POST ${root}/shared-documents/ranking/entry-1/hide`,
    `DELETE ${root}/shared-documents/ranking/entry-1`,
  ]);
  // publish·revoke·hide·delete는 파괴적 작업이라 매번 사용자 확인을 거친다.
  assert.equal(confirmations.length, 4);
  await assert.rejects(run('content', 'server-keys', 'revoke', contentId, 'not-a-number'));
  await assert.rejects(run('content', 'shared', 'list', contentId, '../etc'));
});

test('content update·info-version은 PATCH·POST 경로와 서버 본문 규칙, 확인 절차를 따른다', async () => {
  const calls: { call: string; body: unknown }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ call: `${init?.method ?? 'GET'} ${url.pathname}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ data: { ok: true } }), { headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
  };
  const confirmations: string[] = [];
  const ctx: CommandContext = { api: new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', token: `pat_${'a'.repeat(64)}`, fetch: fetcher }),
    options: {}, output: () => {}, confirm: async (message) => { confirmations.push(message); } };
  const runtime: Runtime = { action(command, handler) { command.action(async (...values: unknown[]) => {
    await handler(ctx, values.slice(0, -2) as string[], (values.at(-1) as Command).opts());
  }); } };
  async function run(...args: string[]) {
    const program = new Command().exitOverride();
    registerContentCommands(program, runtime);
    await program.parseAsync(args, { from: 'user' });
  }
  const root = `/v4/creator/contents/${contentId}`;
  await run('content', 'update', contentId, '--title', '  새 제목 ', '--description', '', '--thumbnail-id', 'none', '--tags', '#여행, travel');
  await run('content', 'update', contentId, '--metadata-mode', 'localized', '--metadata-lang', 'ko',
    '--localized-metadata', '{"en":{"title":"Title","description":"About"}}');
  await run('content', 'update', contentId, '--tags', '');
  await run('content', 'update', contentId, '--title', '  ');
  await run('content', 'info-version', contentId, versionId);
  assert.deepEqual(calls, [
    { call: `PATCH ${root}`, body: { title: '새 제목', description: '', thumbnail_id: null, tags: ['#여행', 'travel'] } },
    { call: `PATCH ${root}`, body: { metadata_mode: 'localized', metadata_lang: 'ko', localized_metadata: { en: { title: 'Title', description: 'About' } } } },
    { call: `PATCH ${root}`, body: { tags: [] } },
    { call: `PATCH ${root}`, body: { title: '' } },
    { call: `POST ${root}/versions/${versionId}/info-version`, body: undefined },
  ]);
  assert.equal(confirmations.length, 1);
  // 서버가 거부할 입력은 요청 전에 막는다.
  const before = calls.length;
  await assert.rejects(run('content', 'update', contentId));
  await assert.rejects(run('content', 'update', contentId, '--title', 'x'.repeat(121)));
  await assert.rejects(run('content', 'update', contentId, '--thumbnail-id', 'not-uuid'));
  await assert.rejects(run('content', 'update', contentId, '--metadata-mode', 'localized'));
  await assert.rejects(run('content', 'update', contentId, '--metadata-mode', 'localized', '--metadata-lang', 'ko', '--localized-metadata', '{"ko":{"title":"a"}}'));
  await assert.rejects(run('content', 'update', contentId, '--localized-metadata', '{깨짐'));
  await assert.rejects(run('content', 'update', contentId, '--tags', 'a-b'));
  await assert.rejects(run('content', 'update', contentId, '--tags', 'ǆ'.repeat(30)));
  await assert.rejects(run('content', 'update', contentId, '--tags', Array.from({ length: 11 }, (_, i) => `t${i}`).join(',')));
  await assert.rejects(run('content', 'info-version', 'not-uuid', versionId));
  assert.equal(calls.length, before);
});
