import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { ApiClient } from '../src/core/api.js';
import type { CommandContext, Runtime } from '../src/core/types.js';
import { registerPlatformCommands } from '../src/commands/platform.js';

const serverKey = `csk_${'a'.repeat(64)}`;
const pat = `pat_${'b'.repeat(64)}`;
const viewer = `v_${'a'.repeat(26)}`;

function fixture(fetcher: typeof fetch, dryRun = false) {
  const output: unknown[] = [];
  let confirmations = 0;
  const program = new Command();
  const api = new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', token: pat, fetch: fetcher });
  const runtime: Runtime = { action(command, handler) {
    command.action(async (...values: unknown[]) => {
      const cmd = values.at(-1) as Command;
      const ctx: CommandContext = { api, options: { dryRun }, output: value => { output.push(value); },
        confirm: async () => { confirmations++; } };
      await handler(ctx, values.slice(0, -2) as string[], cmd.optsWithGlobals());
    });
  } };
  registerPlatformCommands(program, runtime);
  return { program, output, confirmations: () => confirmations };
}

function response(data: unknown) {
  return new Response(JSON.stringify({ data }), { headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
}

test('플랫폼 사용량은 서버 키와 UTC 계약을 사용하고 PAT를 전송하지 않는다', async () => {
  const previous = process.env.CLACK_SERVER_KEY;
  process.env.CLACK_SERVER_KEY = serverKey;
  try {
    let calls = 0;
    const { program, output } = fixture((async (input, init) => {
      calls++;
      const url = new URL(String(input));
      assert.equal(url.pathname, '/platform/v1/usage');
      assert.equal(url.searchParams.get('from'), '2026-09-01T00:00:00.000Z');
      assert.equal(url.searchParams.get('to'), '2026-09-02T00:00:00.000Z');
      assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${serverKey}`);
      assert.equal((init?.headers as Record<string, string>)['X-CLACK-Time-Contract'], 'utc-v1');
      return response({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z', usage: {} });
    }) as typeof fetch);
    await program.parseAsync(['platform', 'usage', '--from', '2026-09-01T00:00:00.000Z', '--to', '2026-09-02T00:00:00.000Z'], { from: 'user' });
    assert.equal(calls, 1);
    assert.equal(output.length, 1);
  } finally { if (previous === undefined) delete process.env.CLACK_SERVER_KEY; else process.env.CLACK_SERVER_KEY = previous; }
});

test('서버 키가 없거나 PAT이면 요청 전에 차단한다', async () => {
  const previous = process.env.CLACK_SERVER_KEY;
  let calls = 0;
  try {
    for (const key of ['', pat]) {
      process.env.CLACK_SERVER_KEY = key;
      const { program } = fixture((async () => { calls++; return response({}); }) as typeof fetch);
      await assert.rejects(program.parseAsync(['platform', 'usage'], { from: 'user' }), { code: 'SERVER_KEY_REQUIRED' });
    }
    assert.equal(calls, 0);
  } finally { if (previous === undefined) delete process.env.CLACK_SERVER_KEY; else process.env.CLACK_SERVER_KEY = previous; }
});

test('문서 조회는 계약 경로와 쿼리를 사용하고 잘못된 입력을 요청 전에 거부한다', async () => {
  const previous = process.env.CLACK_SERVER_KEY;
  process.env.CLACK_SERVER_KEY = serverKey;
  try {
    const paths: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      paths.push(String(input));
      return response({ collection: 'scores', key: 'slot', owner: viewer, rev: 1, body: {},
        created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z' });
    }) as typeof fetch;
    const get = fixture(fetcher);
    await get.program.parseAsync(['platform', 'data', 'get', 'scores', '@me', '--viewer-id', viewer], { from: 'user' });
    assert.equal(new URL(paths[0]!).pathname, '/platform/v1/data/scores/docs/@me');
    assert.equal(new URL(paths[0]!).searchParams.get('viewer_id'), viewer);
    const invalid = fixture(fetcher);
    await assert.rejects(invalid.program.parseAsync(['platform', 'data', 'get', '../scores', 'slot'], { from: 'user' }), { code: 'VALIDATION_ERROR' });
    assert.equal(paths.length, 1);
  } finally { if (previous === undefined) delete process.env.CLACK_SERVER_KEY; else process.env.CLACK_SERVER_KEY = previous; }
});

test('서버 키는 일반 사용자 API로 보낼 수 없고 PAT는 서버 API로 보낼 수 없다', async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return response({}); }) as typeof fetch;
  await assert.rejects(new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', token: serverKey, fetch: fetcher })
    .request('GET', '/v4/me'), { code: 'SERVER_KEY_SCOPE_INVALID' });
  await assert.rejects(new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', token: pat, fetch: fetcher })
    .request('GET', '/platform/v1/usage'), { code: 'SERVER_KEY_REQUIRED' });
  assert.equal(calls, 0);
});

test('단일 문서 PUT·PATCH는 파일 객체와 개정 조건을 보내고 DELETE의 204를 처리한다', async () => {
  const previous = process.env.CLACK_SERVER_KEY;
  process.env.CLACK_SERVER_KEY = serverKey;
  const directory = await mkdtemp(join(tmpdir(), 'clack-platform-write-'));
  try {
    const file = join(directory, 'body.json');
    await writeFile(file, JSON.stringify({ score: 2 }));
    const methods: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, options?: RequestInit) => {
      const method = options?.method ?? '';
      methods.push(method);
      assert.equal(new URL(String(input)).pathname, '/platform/v1/data/scores/docs/slot');
      const headers = options?.headers as Record<string, string>;
      assert.equal(headers.Authorization, `Bearer ${serverKey}`);
      if (method === 'PUT') {
        assert.equal(headers['If-None-Match'], '*');
        assert.deepEqual(JSON.parse(String(options?.body)), { body: { score: 2 } });
      } else if (method === 'PATCH') {
        assert.equal(headers['If-Match'], '"3"');
        assert.deepEqual(JSON.parse(String(options?.body)), { patch: { score: 2 } });
      } else assert.equal(method, 'DELETE');
      return method === 'DELETE' ? new Response(null, { status: 204, headers: { 'X-CLACK-Time-Contract': 'utc-v1' } })
        : response({ collection: 'scores', key: 'slot', rev: method === 'PUT' ? 1 : 4, body: { score: 2 } });
    }) as typeof fetch;
    const put = fixture(fetcher);
    await put.program.parseAsync(['platform', 'data', 'put', 'scores', 'slot', '--file', file, '--if-absent'], { from: 'user' });
    assert.equal(put.confirmations(), 1);
    const patch = fixture(fetcher);
    await patch.program.parseAsync(['platform', 'data', 'patch', 'scores', 'slot', '--file', file, '--if-rev', '3'], { from: 'user' });
    assert.equal(patch.confirmations(), 1);
    const remove = fixture(fetcher);
    await remove.program.parseAsync(['platform', 'data', 'delete', 'scores', 'slot'], { from: 'user' });
    assert.equal(remove.confirmations(), 1);
    assert.deepEqual(remove.output[0], { data: null, time_contract: 'utc-v1' });
    assert.deepEqual(methods, ['PUT', 'PATCH', 'DELETE']);
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CLACK_SERVER_KEY; else process.env.CLACK_SERVER_KEY = previous;
  }
});

test('문서 쓰기 dry-run은 키 없이 파일을 검사하고 본문을 출력하지 않는다', async () => {
  const previous = process.env.CLACK_SERVER_KEY;
  delete process.env.CLACK_SERVER_KEY;
  const directory = await mkdtemp(join(tmpdir(), 'clack-platform-dry-'));
  try {
    const file = join(directory, 'body.json');
    await writeFile(file, JSON.stringify({ private_note: '출력하면 안 되는 내용' }));
    let calls = 0;
    const dry = fixture((async () => { calls++; return response({}); }) as typeof fetch, true);
    await dry.program.parseAsync(['platform', 'data', 'put', 'scores', 'slot', '--file', file, '--if-absent'], { from: 'user' });
    assert.equal(calls, 0);
    assert.equal(dry.confirmations(), 0);
    assert.ok(!JSON.stringify(dry.output).includes('출력하면 안 되는 내용'));
    assert.equal((dry.output[0] as { dry_run: boolean }).dry_run, true);
    const invalid = fixture((async () => { calls++; return response({}); }) as typeof fetch, true);
    await assert.rejects(invalid.program.parseAsync(['platform', 'data', 'put', 'scores', 'slot', '--file', file], { from: 'user' }),
      { code: 'VALIDATION_ERROR' });
    assert.equal(calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CLACK_SERVER_KEY; else process.env.CLACK_SERVER_KEY = previous;
  }
});
