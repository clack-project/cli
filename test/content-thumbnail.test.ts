import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { ApiClient } from '../src/core/api.js';
import { registerContentCommands } from '../src/commands/content.js';
import type { CommandContext, Runtime } from '../src/core/types.js';

const contentId = '00000000-0000-4000-8000-000000000001';
const thumbnailId = '00000000-0000-4000-8000-000000000002';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+c5WQAAAAASUVORK5CYII=', 'base64');

async function fixture(run: (file: string, ctx: CommandContext, calls: string[], outputs: unknown[], state: { disabled: boolean; limit: number; fail: boolean }) => Promise<void>, dryRun = false) {
  const dir = await mkdtemp(join(tmpdir(), 'clack-thumbnail-'));
  const file = join(dir, '표지.png');
  const calls: string[] = []; const outputs: unknown[] = [];
  const state = { disabled: false, limit: 8 * 1024 * 1024, fail: false };
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname; calls.push(`${init?.method} ${path}`);
    const reply = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
    if (path === '/v4/creator/config') return reply({ thumbnail_upload_enabled: !state.disabled,
      thumbnail_upload: { max_upload_bytes: state.limit, max_input_pixels: 4096 * 4096, formats: ['image/png', 'image/jpeg', 'image/webp'] } });
    if (path === '/v4/creator/thumbnails') {
      assert.ok(init?.body instanceof FormData);
      const upload = init.body.get('file') as File;
      assert.equal(upload.type, 'image/png'); assert.deepEqual(Buffer.from(await upload.arrayBuffer()), png);
      return reply({ id: thumbnailId, status: 'succeeded', image_url: 'https://cdn.clack.kr/test.webp' }, 201);
    }
    if (state.fail) return new Response(JSON.stringify({ code: 'SCOPE_DENIED', message: '권한 확인' }), { status: 403 });
    assert.equal(JSON.parse(String(init?.body)).thumbnail_id, thumbnailId);
    return reply({ id: contentId, thumbnail_url: 'https://cdn.clack.kr/test.webp' });
  };
  const ctx: CommandContext = { api: new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', token: `pat_${'a'.repeat(64)}`, fetch: fetcher, dryRun }),
    options: { dryRun }, output: value => outputs.push(value), confirm: async () => {} };
  try { await writeFile(file, png); await run(file, ctx, calls, outputs, state); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function command(ctx: CommandContext, ...args: string[]) {
  const program = new Command().exitOverride();
  const runtime: Runtime = { action(cmd, handler) { cmd.action(async (...values: unknown[]) => {
    const current = values.at(-1) as Command; await handler(ctx, values.slice(0, -2) as string[], current.opts());
  }); } };
  registerContentCommands(program, runtime); await program.parseAsync(args, { from: 'user' });
}
test('썸네일 발급·기존 연결·신규 생성은 전용 multipart와 작업 ID를 쓴다', async () => fixture(async (file, ctx, calls, outputs) => {
  await command(ctx, 'content', 'thumbnail', file);
  assert.equal((outputs[0] as { data: { id: string } }).data.id, thumbnailId);
  await command(ctx, 'content', 'thumbnail', file, '--content', contentId);
  await command(ctx, 'content', 'update', contentId, '--thumbnail-file', file);
  await command(ctx, 'content', 'create', '--title', '새 콘텐츠', '--policy-version', '2026-09-22', '--thumbnail-file', file);
  assert.equal(calls.filter(call => call === 'POST /v4/creator/thumbnails').length, 4);
  assert.equal(calls.filter(call => call.startsWith('PATCH')).length, 2);
  assert.equal(calls.includes('POST /v4/images/upload'), false);
}));
test('dry-run은 업로드·콘텐츠 쓰기 없이 서버 조건과 로컬 이미지를 검증한다', async () => fixture(async (file, ctx, calls, outputs) => {
  await command(ctx, 'content', 'update', contentId, '--thumbnail-file', file);
  assert.deepEqual(calls, ['GET /v4/creator/config']);
  assert.equal((outputs[0] as { dry_run: boolean }).dry_run, true);
}, true));
test('파일 없음·빈 파일·손상 이미지·초과 용량·기능 중단은 업로드 전에 구별한다', async () => fixture(async (file, ctx, calls, _outputs, state) => {
  await assert.rejects(command(ctx, 'content', 'thumbnail', file + '.missing'), { code: 'THUMBNAIL_FILE_NOT_FOUND' });
  await writeFile(file, ''); await assert.rejects(command(ctx, 'content', 'thumbnail', file), { code: 'THUMBNAIL_EMPTY_FILE' });
  await writeFile(file, 'broken'); await assert.rejects(command(ctx, 'content', 'thumbnail', file), { code: 'THUMBNAIL_INVALID_IMAGE' });
  await writeFile(file, png); state.limit = 2;
  await assert.rejects(command(ctx, 'content', 'thumbnail', file), { code: 'THUMBNAIL_TOO_LARGE' });
  state.disabled = true;
  await assert.rejects(command(ctx, 'content', 'thumbnail', file), { code: 'THUMBNAIL_UPLOAD_DISABLED' });
  assert.equal(calls.some(call => call.startsWith('POST')), false);
}));
test('잘못된 콘텐츠 ID와 충돌 옵션은 썸네일을 올리지 않는다', async () => fixture(async (file, ctx, calls) => {
  await assert.rejects(command(ctx, 'content', 'thumbnail', file, '--content', 'bad'));
  await assert.rejects(command(ctx, 'content', 'update', 'bad', '--thumbnail-file', file));
  await assert.rejects(command(ctx, 'content', 'update', contentId, '--thumbnail-file', file, '--thumbnail-id', thumbnailId));
  assert.deepEqual(calls, []);
}));
test('연결 실패 뒤 작업 ID와 재연결 명령을 제공하고 자동 재업로드하지 않는다', async () => fixture(async (file, ctx, calls, _outputs, state) => {
  state.fail = true;
  await assert.rejects(command(ctx, 'content', 'thumbnail', file, '--content', contentId), (error: any) => {
    assert.equal(error.code, 'SCOPE_DENIED'); assert.equal(error.recovery.thumbnail_id, thumbnailId);
    assert.equal(error.recovery.content_id, contentId); assert.match(error.recovery.retry_command, /--thumbnail-id/); return true;
  });
  assert.equal(calls.filter(call => call === 'POST /v4/creator/thumbnails').length, 1);
}));
