import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlatformMcpServer } from '../src/lib/platform-mcp.js';
import { platformMcpConfiguration } from '../src/commands/integrations.js';
import { prepareSkillPackage } from '../src/lib/skill-package.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const key = `csk_${'a'.repeat(64)}`;
const pat = `pat_${'b'.repeat(64)}`;
const init = { jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };

test('MCP 초기화와 읽기 도구 목록은 표준 JSON-RPC 결과를 반환한다', async () => {
  const server = new PlatformMcpServer({ baseUrl: 'https://v4-api.dev.clack.kr' }, { CLACK_SERVER_KEY: key });
  const hello = await server.handle(init);
  assert.equal((hello?.result as { protocolVersion: string }).protocolVersion, '2025-11-25');
  assert.deepEqual((hello?.result as { capabilities: unknown }).capabilities, { tools: { listChanged: false } });
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  const listed = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = (listed?.result as { tools: { name: string; inputSchema: { type: string } }[] }).tools;
  assert.deepEqual(tools.map(tool => tool.name), ['platform_authoring', 'platform_usage_get', 'platform_server_data_get',
    'platform_server_data_list', 'platform_server_data_leaderboard', 'platform_server_data_put',
    'platform_server_data_patch', 'platform_server_data_delete', 'platform_skill_list', 'platform_skill_get',
    'platform_skill_push', 'platform_skill_status', 'platform_skill_submit', 'platform_skill_release',
    'platform_content_publish', 'platform_shared_collections_list', 'platform_shared_documents_list',
    'platform_shared_document_get', 'platform_shared_document_hide', 'platform_shared_document_delete']);
  assert.ok(tools.every(tool => tool.inputSchema.type === 'object'));
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'platform_data_write', arguments: {} } }))?.error?.code, -32602);
});

test('MCP 조회는 공유 CLI 검증과 csk 인증을 사용하고 비밀을 출력하지 않는다', async () => {
  let calls = 0;
  const server = new PlatformMcpServer({ baseUrl: 'https://v4-api.dev.clack.kr', fetch: (async (input, options) => {
    calls++;
    assert.equal(new URL(String(input)).pathname, '/platform/v1/usage');
    assert.equal((options?.headers as Record<string, string>).Authorization, `Bearer ${key}`);
    return new Response(JSON.stringify({ data: { from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-02T00:00:00.000Z', usage: {} } }), { headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
  }) as typeof fetch }, { CLACK_SERVER_KEY: key, CLACK_TOKEN: `pat_${'b'.repeat(64)}` });
  await server.handle(init);
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const bad = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'platform_usage_get', arguments: { from: '2026-09-02T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' } } });
  assert.equal((bad?.result as { isError: boolean }).isError, true);
  assert.equal(calls, 0);
  const okay = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'platform_usage_get', arguments: {} } });
  assert.equal(calls, 1);
  assert.equal((okay?.result as { isError?: boolean }).isError, undefined);
  assert.ok(!JSON.stringify(okay).includes(key));
});

test('서버 키 누락 오류와 MCP 설정은 자격 원문을 노출하지 않는다', async () => {
  const server = new PlatformMcpServer({ baseUrl: 'https://v4-api.dev.clack.kr' }, { CLACK_SERVER_KEY: '' });
  await server.handle(init);
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const result = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'platform_usage_get', arguments: {} } });
  assert.equal((result?.result as { isError: boolean }).isError, true);
  const config = platformMcpConfiguration('https://v4-api.dev.clack.kr');
  assert.deepEqual(config.claude_config.mcpServers.clack_platform.args,
    ['mcp', 'serve-platform', '--base-url', 'https://v4-api.dev.clack.kr']);
  assert.ok(!JSON.stringify(config).includes(key));
  assert.ok(!JSON.stringify(result).includes(key));
});

test('MCP 문서 쓰기는 본문 없는 미리보기 후 confirm:true에서만 단일 문서를 변경한다', async () => {
  let calls = 0;
  const server = new PlatformMcpServer({ baseUrl: 'https://v4-api.dev.clack.kr', fetch: (async (input, options) => {
    calls++;
    assert.equal(new URL(String(input)).pathname, '/platform/v1/data/scores/docs/slot');
    assert.equal((options?.headers as Record<string, string>).Authorization, `Bearer ${key}`);
    if (options?.method === 'PUT') {
      assert.equal((options.headers as Record<string, string>)['If-None-Match'], '*');
      assert.deepEqual(JSON.parse(String(options.body)), { body: { score: 1 } });
      return new Response(JSON.stringify({ data: { rev: 1, body: { score: 1 } } }),
        { headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
    }
    if (options?.method === 'PATCH') {
      assert.equal((options.headers as Record<string, string>)['If-Match'], '"1"');
      assert.deepEqual(JSON.parse(String(options.body)), { patch: { score: 2 } });
      return new Response(JSON.stringify({ data: { rev: 2, body: { score: 2 } } }),
        { headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
    }
    assert.equal(options?.method, 'DELETE');
    return new Response(null, { status: 204, headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
  }) as typeof fetch }, { CLACK_SERVER_KEY: key });
  await server.handle(init);
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const args = { collection: 'scores', key: 'slot', body: { score: 1 }, if_absent: true };
  const preview = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'platform_server_data_put', arguments: args } });
  assert.equal(calls, 0);
  assert.equal((preview?.result as { structuredContent: { confirmation_required: boolean } }).structuredContent.confirmation_required, true);
  assert.ok(!JSON.stringify(preview).includes('"score":1'));
  const changed = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'platform_server_data_put', arguments: { ...args, confirm: true } } });
  assert.equal(calls, 1);
  assert.equal((changed?.result as { isError?: boolean }).isError, undefined);
  const patched = await server.handle({ jsonrpc: '2.0', id: 31, method: 'tools/call',
    params: { name: 'platform_server_data_patch', arguments: { collection: 'scores', key: 'slot', patch: { score: 2 }, if_rev: 1, confirm: true } } });
  assert.equal(calls, 2);
  assert.equal((patched?.result as { structuredContent: { data: { rev: number } } }).structuredContent.data.rev, 2);
  const removePreview = await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'platform_server_data_delete', arguments: { collection: 'scores', key: 'slot' } } });
  assert.equal((removePreview?.result as { structuredContent: { confirmation_required: boolean } }).structuredContent.confirmation_required, true);
  assert.equal(calls, 2);
  const removed = await server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'platform_server_data_delete', arguments: { collection: 'scores', key: 'slot', confirm: true } } });
  assert.equal(calls, 3);
  assert.equal((removed?.result as { structuredContent: { data: unknown } }).structuredContent.data, null);
});

test('platform:read·platform:write PAT 도구는 CLACK_TOKEN을 사용하고 파괴적 도구는 confirm 전에는 실행하지 않는다', async () => {
  const content_id = '00000000-0000-4000-8000-000000000001';
  const version_id = '00000000-0000-4000-8000-000000000002';
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${pat}`);
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (init?.method === 'DELETE') return new Response(null, { status: 204, headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
    return new Response(JSON.stringify({ data: { ok: true } }), { headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
  };
  const server = new PlatformMcpServer({ baseUrl: 'https://v4-api.dev.clack.kr', fetch: fetcher },
    { CLACK_SERVER_KEY: '', CLACK_TOKEN: pat });
  await server.handle(init);
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const call = (name: string, args: unknown, id = 9) => server.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

  const previewed = await call('platform_content_publish', { content_id, version_id });
  assert.equal(calls.length, 0);
  assert.equal((previewed?.result as { structuredContent: { confirmation_required: boolean } }).structuredContent.confirmation_required, true);
  const published = await call('platform_content_publish', { content_id, version_id, confirm: true });
  assert.equal((published?.result as { isError?: boolean }).isError, undefined);
  assert.deepEqual(calls[0], { method: 'POST', path: `/v4/creator/contents/${content_id}/versions/${version_id}/publish`, body: undefined });

  const hidden = await call('platform_shared_document_hide', { content_id, collection: 'ranking', key: 'entry-1', confirm: true });
  assert.equal((hidden?.result as { isError?: boolean }).isError, undefined);
  assert.equal(calls.at(-1)?.path, `/v4/creator/contents/${content_id}/shared-documents/ranking/entry-1/hide`);

  const deleted = await call('platform_shared_document_delete', { content_id, collection: 'ranking', key: 'entry-1', confirm: true });
  assert.equal((deleted?.result as { isError?: boolean }).isError, undefined);
  assert.equal(calls.at(-1)?.method, 'DELETE');

  const listed = await call('platform_shared_documents_list', { content_id, collection: 'ranking' });
  assert.equal((listed?.result as { isError?: boolean }).isError, undefined);
  assert.equal(calls.at(-1)?.path, `/v4/creator/contents/${content_id}/shared-documents/ranking`);

  const noToken = new PlatformMcpServer({ baseUrl: 'https://v4-api.dev.clack.kr', fetch: fetcher }, { CLACK_SERVER_KEY: '', CLACK_TOKEN: '' });
  await noToken.handle(init);
  await noToken.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const denied = await noToken.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'platform_shared_documents_list', arguments: { content_id, collection: 'ranking' } } });
  assert.equal((denied?.result as { isError: boolean }).isError, true);
  assert.match((denied?.result as { content: { text: string }[] }).content[0]!.text, /PAT_REQUIRED/);
});

test('platform_skill_push는 로컬 스킬 패키지를 CLACK_TOKEN으로 검증·업로드한다', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'clack-platform-mcp-'));
  const dir = join(temp, 'my-skill');
  await mkdir(dir);
  await writeFile(join(dir, 'SKILL.md'), '---\nname: my-skill\ndescription: 제작 지침을 적용합니다\nmetadata:\n  version: 1.0.0\n---\n\n안전하게 제작하세요.\n');
  await writeFile(join(dir, 'clack.skill.json'), JSON.stringify({ manifest_version: 1, name: 'my-skill', version: '1.0.0', type: 'instruction',
    display: { title: { ko: '내 스킬' }, summary: { ko: '제작 지침' }, category: 'story' },
    authoring: { modes: ['agent'], surfaces: ['cli'] }, output: { content_kind: 'html' } }));
  const skillId = '00000000-0000-4000-8000-000000000003';
  const versionId = '00000000-0000-4000-8000-000000000004';
  const s3Url = 'https://clack-creator-content-dev-123456789012-ap-northeast-2.s3.ap-northeast-2.amazonaws.com/_staging/1/upload?signature=test';
  const calls: string[] = [];
  const apiFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${pat}`);
    const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
    if (url.pathname.endsWith('/validate')) return json({ valid: true });
    if (url.pathname === '/v4/creator/skills') return json({ id: skillId, slug: 'my-skill', type: 'instruction' }, 201);
    if (url.pathname.endsWith('/versions')) {
      const prepared = await prepareSkillPackage(dir);
      return json({ version_id: versionId, upload_url: s3Url,
        headers: { 'Content-Type': 'application/zip', 'x-amz-checksum-sha256': createHash('sha256').update(prepared.bytes).digest('base64') },
        expires_at: '2026-09-23T12:00:00.000Z', max_upload_bytes: 10485760 }, 201);
    }
    if (url.pathname.endsWith('/complete')) return json({ id: versionId, skill_id: skillId, version: '1.0.0', review_status: 'validated' });
    throw new Error('예상하지 못한 API');
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => { assert.equal(new Headers(init?.headers).get('Authorization'), null); calls.push('S3 PUT'); return new Response(null, { status: 200 }); };
  try {
    const server = new PlatformMcpServer({ baseUrl: 'https://v4-api.dev.clack.kr', fetch: apiFetch }, { CLACK_SERVER_KEY: '', CLACK_TOKEN: pat });
    await server.handle(init);
    await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const result = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'platform_skill_push', arguments: { dir } } });
    assert.equal((result?.result as { isError?: boolean }).isError, undefined);
    assert.deepEqual(calls, ['/v4/creator/skills/validate', '/v4/creator/skills', `/v4/creator/skills/${skillId}/versions`,
      'S3 PUT', `/v4/creator/skills/${skillId}/versions/${versionId}/complete`]);
    assert.deepEqual((result?.result as { structuredContent: unknown }).structuredContent,
      { skill_id: skillId, slug: 'my-skill', version_id: versionId, version: '1.0.0', review_status: 'validated' });
  } finally { globalThis.fetch = originalFetch; await rm(temp, { recursive: true, force: true }); }
});

test('stdio는 줄바꿈 JSON-RPC 프레이밍을 사용하고 stdout에 프로토콜 메시지만 쓴다', () => {
  const inputs = [init, { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'platform_usage_get', arguments: {} } }]
    .map(item => JSON.stringify(item)).join('\n') + '\n';
  const env = { ...process.env, CLACK_SERVER_KEY: '', CLACK_TOKEN: `pat_${'b'.repeat(64)}` };
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'mcp', 'serve-platform', '--env', 'dev'],
    { cwd: root, env, input: inputs, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const frames = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(frames.map(frame => frame.id), [1, 2, 3]);
  assert.equal(frames[1].result.tools.length, 20);
  assert.equal(frames[2].result.isError, true);
  assert.ok(!result.stdout.includes(env.CLACK_TOKEN));
});
