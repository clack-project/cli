import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { output } from '../src/core/runtime.js';
import { ApiClient } from '../src/core/api.js';
import { CliError } from '../src/core/errors.js';
import type { CommandContext, Runtime } from '../src/core/types.js';
import { registerProductCommands } from '../src/commands/product.js';
import { registerPostCommands } from '../src/commands/post.js';
import { registerMeCommands } from '../src/commands/me.js';
import { registerChannelCommands } from '../src/commands/channel.js';
import { registerUploadCommands } from '../src/commands/upload.js';

const TOKEN = 'pat_' + 'a'.repeat(64);
const PRODUCT = { type: 'sell', images: ['https://storage.dev.clack.kr/image.png'], name: '테스트', category: '아크릴 > 아크릴 스탠드', price: 1000, description: '설명' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV0cAAAAASUVORK5CYII=', 'base64');
function harness(options: { dryRun?: boolean; confirm?: boolean; respond?: (request: { method: string; url: URL; body: any; headers: Headers }) => { status?: number; data?: unknown; pagination?: unknown; error?: unknown; contract?: string } } = {}) {
  const calls: Array<{ method: string; url: URL; body: any; headers: Headers }> = [];
  const outputs: any[] = []; let confirmations = 0;
  const api = new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', token: TOKEN, dryRun: options.dryRun, fetch: async (input, init) => {
    const request = { method: init!.method!, url: new URL(String(input)), body: typeof init!.body === 'string' ? JSON.parse(init!.body) : init!.body, headers: new Headers(init!.headers) }; calls.push(request);
    const result = options.respond?.(request) ?? { data: { id: 1 } };
    const body = result.error ?? { data: result.data ?? { id: 1 }, ...(result.pagination ? { pagination: result.pagination } : {}) };
    return new Response(JSON.stringify(body), { status: result.status ?? 200, headers: { 'X-CLACK-Time-Contract': result.contract ?? request.headers.get('X-CLACK-Time-Contract')! } });
  } });
  const ctx: CommandContext = { api, options: { dryRun: options.dryRun }, output: (value) => outputs.push(value), confirm: async () => { confirmations++; if (!options.confirm) throw new CliError('확인 필요', 'CONFIRMATION_REQUIRED'); } };
  const runtime: Runtime = { action(command, handler) { command.action(async (...values: any[]) => { const cmd = values.at(-1) as Command; await handler(ctx, values.slice(0, -2), cmd.optsWithGlobals()); }); } };
  const program = new Command().exitOverride();
  for (const register of [registerProductCommands, registerPostCommands, registerMeCommands, registerChannelCommands, registerUploadCommands]) register(program, runtime);
  return { run: (args: string[]) => program.parseAsync(args, { from: 'user' }), calls, outputs, get confirmations() { return confirmations; } };
}
async function fixture(fn: (dir: string) => Promise<void>): Promise<void> { const dir = await mkdtemp(join(tmpdir(), 'clack-domains-')); try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); process.exitCode = 0; } }

test('로컬 이미지를 포함한 상품 dry-run은 API·업로드를 호출하지 않는다', () => fixture(async (dir) => {
  await writeFile(join(dir, 'image.png'), PNG); await writeFile(join(dir, 'product.json'), JSON.stringify({ ...PRODUCT, images: ['image.png'] }));
  const h = harness({ dryRun: true }); await h.run(['product', 'create', '-f', join(dir, 'product.json')]);
  assert.equal(h.calls.length, 0); assert.equal(h.outputs[0].results[0].dry_run, true);
}));
test('잘못된 상품은 업로드 전에 거부한다', () => fixture(async (dir) => {
  await writeFile(join(dir, 'image.png'), PNG); await writeFile(join(dir, 'product.json'), JSON.stringify({ ...PRODUCT, name: '', images: ['image.png'] }));
  const h = harness(); await assert.rejects(h.run(['product', 'create', '-f', join(dir, 'product.json')]), /name/); assert.equal(h.calls.length, 0);
}));
test('단건 상품 생성은 서버 legacy 계약과 업로드 썸네일을 보존한다', () => fixture(async (dir) => {
  await writeFile(join(dir, 'image.png'), PNG); await writeFile(join(dir, 'product.json'), JSON.stringify({ ...PRODUCT, images: ['image.png'] }));
  const h = harness({ respond: (request) => request.url.pathname.endsWith('/upload') ? { data: { originalUrl: 'https://storage.dev.clack.kr/new.png', thumbnail400Url: 'https://storage.dev.clack.kr/thumb.png' } } : { data: { id: 20, created_at: '2026-09-19T10:00:00Z' } } });
  await h.run(['product', 'create', '-f', join(dir, 'product.json')]);
  assert.ok(h.calls[0].body instanceof FormData); assert.deepEqual(h.calls[1].body.images, ['https://storage.dev.clack.kr/new.png']); assert.equal(h.calls[1].body.thumbnail_400, 'https://storage.dev.clack.kr/thumb.png'); assert.equal(h.outputs[0].time_contract, 'legacy-kst');
}));
test('이미지 업로드는 로컬 원본 파일명 대신 무작위 파일명(확장자 유지)을 서버로 보낸다', () => fixture(async (dir) => {
  await writeFile(join(dir, '원본-비밀-파일명.png'), PNG);
  await writeFile(join(dir, 'product.json'), JSON.stringify({ ...PRODUCT, images: ['원본-비밀-파일명.png'] }));
  const h = harness({ respond: (request) => request.url.pathname.endsWith('/upload') ? { data: { originalUrl: 'https://storage.dev.clack.kr/new.png' } } : { data: { id: 21, created_at: '2026-09-19T10:00:00Z' } } });
  await h.run(['product', 'create', '-f', join(dir, 'product.json')]);
  const upload = h.calls.find(call => call.url.pathname.endsWith('/upload'));
  assert.ok(upload); const file = (upload!.body as FormData).get('file') as any;
  assert.ok(file); assert.notEqual(file.name, '원본-비밀-파일명.png'); assert.doesNotMatch(file.name, /원본|비밀/);
  assert.match(file.name, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/);
  assert.equal(file.type, 'image/png');
}));
test('거래완료·삭제 확인 실패는 쓰기를 호출하지 않는다', async () => {
  for (const args of [['product', 'status', '1', 'sold'], ['post', 'delete', '1'], ['channel', 'post', 'delete', '1'], ['me', 'address', 'delete', '1']]) { const h = harness(); await assert.rejects(h.run(args), /확인 필요/); assert.equal(h.calls.length, 0); assert.equal(h.confirmations, 1); }
  const h = harness(); await h.run(['product', 'status', '1', 'selling']); assert.equal(h.calls[0].body.order_status, null);
  await assert.rejects(h.run(['product', 'status', '1', '__proto__']));
});
test('일괄 끌어올리기는 실제 /v4/my/bulk-bump 경로를 사용한다', async () => { const h = harness(); await h.run(['product', 'bump', '--all']); assert.equal(h.calls[0].url.pathname, '/v4/my/bulk-bump/execute'); });
test('배치 재개는 성공·불확정 항목을 건너뛰며 실패만 재시도한다', () => fixture(async (dir) => {
  const report = { version: 1, command: 'product.create', results: [{ index: 0, input: PRODUCT, ok: true, id: 10 }, { index: 1, input: { ...PRODUCT, name: '재개' }, ok: false }, { index: 2, input: PRODUCT, ok: false, retryable: false, code: 'OUTCOME_UNKNOWN' }], summary: {} };
  await writeFile(join(dir, 'report.json'), JSON.stringify(report)); const h = harness(); await h.run(['product', 'create', '--resume', join(dir, 'report.json')]);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].body.name, '재개'); assert.equal(h.outputs[0].ok, false); assert.equal(h.outputs[0].data.results[2].ok, false);
}));
test('배치 결과 파일은 오류의 PAT를 가리고 불확정 결과를 표시한다', () => fixture(async (dir) => {
  await writeFile(join(dir, 'products.json'), JSON.stringify([PRODUCT, { ...PRODUCT, name: '둘째' }]));
  const h = harness({ respond: ({ body }) => body.name === '둘째' ? { status: 500, error: { message: TOKEN } } : { status: 422, error: { message: TOKEN } } });
  await h.run(['product', 'create', '-f', join(dir, 'products.json'), '--report', join(dir, 'report.json')]);
  const content = await readFile(join(dir, 'report.json'), 'utf8'); assert.equal(content.includes(TOKEN), false); const result = JSON.parse(content); assert.equal(result.results[1].retryable, false); assert.equal(result.results[1].code, 'OUTCOME_UNKNOWN'); if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'report.json'))).mode & 0o777, 0o600);
}));
test('페이지 도중 legacy fallback이 발생하면 전체 페이지를 legacy로 다시 읽는다', async () => {
  const h = harness({ respond: (request) => {
    const cursor = request.url.searchParams.get('cursor'); const contract = request.headers.get('X-CLACK-Time-Contract');
    if (cursor && contract === 'utc-v1') return { status: 406, error: { code: 'TIME_CONTRACT_NOT_READY', supported: ['legacy-kst'] }, contract: 'legacy-kst' };
    return { data: [{ id: cursor ? 2 : 1, created_at: contract === 'utc-v1' ? '2026-09-19T01:00:00Z' : '2026-09-19T10:00:00Z' }], pagination: { has_more: !cursor, next_cursor: cursor ? null : '2' } };
  } });
  await h.run(['product', 'list', '--all']); assert.equal(h.outputs[0].time_contract, 'legacy-kst'); assert.equal(h.outputs[0].data.length, 2); assert.ok(h.outputs[0].data.every((item: any) => item.created_at.endsWith('10:00:00Z'))); assert.equal(h.calls.length, 5);
});
test('게시판 유형을 확인하고 dry-run에서 이미지 업로드를 생략한다', () => fixture(async (dir) => {
  await writeFile(join(dir, 'image.png'), PNG); const h = harness({ dryRun: true, respond: () => ({ data: [{ board_id: 'challenge', board_type: 'image', can_write: true }] }) });
  await h.run(['post', 'create', '--feed', '--content', '내용', '--images', join(dir, 'image.png')]); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].method, 'GET'); assert.equal(h.outputs[0].dry_run, true);
}));
test('채널 마크다운은 로컬 크기를 측정하지만 dry-run에서 업로드하지 않는다', () => fixture(async (dir) => {
  await writeFile(join(dir, 'image.png'), PNG); await writeFile(join(dir, 'draft.md'), '문단\n\n![이미지](image.png)');
  const h = harness({ dryRun: true }); await h.run(['channel', 'post', 'create', '--channel-id', '1', '--from-markdown', join(dir, 'draft.md')]); assert.equal(h.calls.length, 0); assert.equal(h.outputs[0].body.content[1].width, 1); assert.equal(h.outputs[0].body.status, 'draft');
}));
test('프로필·업로드 dry-run은 파일 검증만 하며 비밀번호는 비TTY에서 거부한다', () => fixture(async (dir) => {
  await writeFile(join(dir, 'image.png'), PNG);
  const me = harness({ dryRun: true }); await me.run(['me', 'update', '--avatar', join(dir, 'image.png')]); assert.equal(me.calls.length, 0);
  await assert.rejects(me.run(['me', 'update', '--avatar', 'https://evil.test/avatar.png']), /CDN/);
  const upload = harness({ dryRun: true }); await upload.run(['upload', join(dir, 'image.png')]); assert.equal(upload.calls.length, 0);
  if (!process.stdin.isTTY || !process.stdout.isTTY) await assert.rejects(me.run(['me', 'password', 'change']), /대화형 터미널/);
}));
test('공개 이메일 인증은 PAT 헤더 없이 요청한다', async () => { const h = harness(); await h.run(['me', 'email', 'verify', 'test@example.com', '123456']); assert.equal(h.calls[0].headers.has('Authorization'), false); assert.equal(h.calls[0].body.type, 'notification_email'); });

test('배치 일부 실패의 JSON 출력은 ok:false이고 그대로 실패 항목만 재개할 수 있다', () => fixture(async (dir) => {
  await writeFile(join(dir, 'products.json'), JSON.stringify([PRODUCT, { ...PRODUCT, name: '재시도' }]));
  const initial = harness({ respond: ({ body }) => body.name === '재시도' ? { status: 422, error: { message: '입력을 확인하세요.' } } : { data: { id: 10 } } });
  await initial.run(['product', 'create', '-f', join(dir, 'products.json')]);
  assert.equal(process.exitCode, 6);
  let rendered = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { rendered += String(chunk); return true; }) as typeof process.stdout.write;
  try { output(initial.outputs[0], { json: true }); } finally { process.stdout.write = originalWrite; }
  const envelope = JSON.parse(rendered);
  assert.equal(envelope.ok, false); assert.equal(envelope.status, 422); assert.equal(envelope.code, 'BATCH_FAILED');
  assert.deepEqual(envelope.data.summary, { total: 2, succeeded: 1, failed: 1 });
  await writeFile(join(dir, 'output.json'), rendered);
  process.exitCode = 0;
  const resumed = harness(); await resumed.run(['product', 'create', '--resume', join(dir, 'output.json')]);
  assert.equal(resumed.calls.length, 1); assert.equal(resumed.calls[0].body.name, '재시도');
  assert.deepEqual(resumed.outputs[0].summary, { total: 2, succeeded: 2, failed: 0 }); assert.equal(process.exitCode, 0);
}));
