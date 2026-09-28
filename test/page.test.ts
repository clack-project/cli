import test from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { ApiClient } from '../src/core/api.js';
import type { CommandContext, Runtime } from '../src/core/types.js';
import { registerPageCommands } from '../src/commands/page.js';
import { parseScopes } from '../src/commands/auth.js';

const pageId = '00000000-0000-4000-8000-000000000001';
const versionId = '00000000-0000-4000-8000-000000000002';

function commands(ctx: CommandContext) {
  const program = new Command().exitOverride();
  const runtime: Runtime = { action(command, handler) {
    command.action(async (...values: unknown[]) => {
      const cmd = values.at(-1) as Command;
      await handler(ctx, values.slice(0, -2) as string[], cmd.opts());
    });
  } };
  registerPageCommands(program, runtime);
  return (args: string[]) => program.parseAsync(args, { from: 'user' });
}

test('페이지 권한 약식은 공개 권한을 자동 추가하지 않는다', () => {
  assert.deepEqual(parseScopes('custom-page'), ['custom-page:read', 'custom-page:write']);
  assert.deepEqual(parseScopes('custom-page:publish'), ['custom-page:publish']);
});

test('페이지 적용·복원·해제는 수정 번호를 보내고 심사에 자동 적용을 요청하지 않는다', async () => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let confirmed = 0;
  const ctx: CommandContext = {
    api: new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', token: 'pat_test', fetch: async (input, init) => {
      calls.push({ method: String(init?.method), path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ data: { ok: true } }), { headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
    } }), options: {}, output: () => undefined, confirm: async () => { confirmed++; },
  };
  for (const action of ['apply', 'restore']) await commands(ctx)(['page', action, pageId, versionId, '--revision', '7']);
  await commands(ctx)(['page', 'disable', pageId, '--revision', '8']);
  await commands(ctx)(['page', 'submit', pageId, versionId]);
  assert.equal(confirmed, 4);
  assert.deepEqual(calls.map(item => item.body), [{ version_id: versionId, revision: 7 }, { version_id: versionId, revision: 7 }, { revision: 8 }, {}]);
  assert.ok(calls.every(item => item.path.startsWith(`/v4/creator/custom-pages/${pageId}/`)));
  const count = calls.length;
  await assert.rejects(commands(ctx)(['page', 'apply', pageId, versionId, '--revision', '1.5']));
  await assert.rejects(commands(ctx)(['page', 'create', '--target', 'profile', '--space-id', pageId, '--policy-version', '2026-09-22']));
  assert.equal(calls.length, count);
  await commands(ctx)(['page', 'presentation', pageId, versionId, '--header', 'floating_close', '--color', 'dark']);
  assert.equal(calls.at(-1)?.path, `/v4/creator/custom-pages/${pageId}/versions/${versionId}/presentation`);
  assert.deepEqual(calls.at(-1)?.body, { presentation: { schema_version: 1, header_mode: 'floating_close', color_scheme: 'dark' } });
});
