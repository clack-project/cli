import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { ApiClient } from '../src/core/api.js';
import { authoringRequest } from '../src/commands/authoring.js';
import { prepareSkillPackage } from '../src/lib/skill-package.js';

// 실제 스킬 패키지 샘플은 모노레포(clack-api-v4/skills)에만 있다. 공개 저장소 단독 체크아웃에서는
// CLACK_MONOREPO_DIR(기본 ../clack)이 없으면 이 스위트를 건너뛴다.
const monorepoDir = resolve(process.env.CLACK_MONOREPO_DIR ?? '../clack');
const skillsFixtureDir = resolve(monorepoDir, 'clack-api-v4/skills');
const hasMonorepoFixtures = existsSync(skillsFixtureDir);

const sessionId = '00000000-0000-4000-8000-000000000001';
test('제작 이미지 배치는 승인 가격과 멱등성 키를 보존하고 중복 항목은 요청 전에 거부한다', async () => {
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const api = new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', token: `pat_${'a'.repeat(64)}`,
    fetch: (async (url, init) => {
      requests.push({ path: new URL(String(url)).pathname, init: init! });
      return new Response(JSON.stringify({ data: {} }), { headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
    }) as typeof fetch });
  const input = { action: 'image-batch', session_id: sessionId, form_revision: 3, asset_slot: 'plates',
    approved_price_cash: 60, idempotency_key: 'album-request-001', item_indexes: [0, 1] };
  await authoringRequest(api, input);
  assert.equal(requests[0]!.path, `/v4/creator/authoring-sessions/${sessionId}/tools/image.generate/batch`);
  assert.equal(new Headers(requests[0]!.init.headers).get('Idempotency-Key'), 'album-request-001');
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { form_revision: 3, asset_slot: 'plates', approved_price_cash: 60, item_indexes: [0, 1] });
  await assert.rejects(authoringRequest(api, { ...input, item_indexes: [0, 0] }));
  assert.equal(requests.length, 1);
});

test('공식 이미지·챗과 서드파티 이미지·챗을 CLI에서도 같은 규격으로 검사한다', { skip: !hasMonorepoFixtures && '모노레포 스킬 샘플 없음 — 건너뜀' }, async () => {
  for (const path of ['clack-character-chat/1.0.1', 'clack-character-chat/2.0.0', 'clack-character-image/1.0.0',
    'examples/third-party/creature-portrait', 'examples/third-party/creature-chat']) {
    const prepared = await prepareSkillPackage(resolve(skillsFixtureDir, path));
    assert.ok(prepared.bytes.length > 0);
  }
});

test('완료·포기는 정상 complete 경로와 outcome만 보내며 종료 오류를 성공으로 바꾸지 않는다', async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  let status = 200;
  let code = '';
  const api = new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', token: `pat_${'c'.repeat(64)}`,
    fetch: (async (url, init) => {
      calls.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
      assert.equal(init?.method, 'POST');
      return new Response(JSON.stringify(status === 200 ? { data: { status: 'completed' } } : { code, message: '오류' }),
        { status, headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
    }) as typeof fetch });
  for (const action of ['complete', 'abandon']) await authoringRequest(api, { action, session_id: sessionId });
  assert.deepEqual(calls.map(x => x.body), [{ outcome: 'completed' }, { outcome: 'abandoned' }]);
  assert.ok(calls.every(x => x.path === `/v4/creator/authoring-sessions/${sessionId}/complete`));
  for (const [httpStatus, errorCode, exit] of [[409, 'AUTHORING_NOT_PACKAGED', 6], [409, 'AUTHORING_SESSION_LOCKED', 6],
    [403, 'SESSION_REQUIRED', 4], [404, 'AUTHORING_NOT_FOUND', 5]] as const) {
    status = httpStatus; code = errorCode;
    await assert.rejects(authoringRequest(api, { action: 'complete', session_id: sessionId }), { code, exitCode: exit });
  }
  const before = calls.length;
  for (const input of [{ action: 'abandon', session_id: '../bad' }, { action: 'complete', session_id: sessionId, outcome: 'abandoned' }]) {
    await assert.rejects(authoringRequest(api, input), { code: 'VALIDATION_ERROR' });
  }
  assert.equal(calls.length, before);
});

test('Commander 종료 하위 명령·JSON·dry-run·포기 확인은 같은 검증을 사용한다', async () => {
  const { Command } = await import('commander');
  const { registerAuthoringCommands } = await import('../src/commands/authoring.js');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(resolve(tmpdir(), 'clack-authoring-test-'));
  let confirms = 0;
  let calls = 0;
  let dryRun = false;
  let rejectConfirmation = false;
  const outputs: unknown[] = [];
  const api = new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', token: `pat_${'d'.repeat(64)}`,
    fetch: (async () => { calls++; return new Response(JSON.stringify({ data: { status: 'completed' } }),
      { headers: { 'X-CLACK-Time-Contract': 'utc-v1' } }); }) as typeof fetch });
  const run = async (args: string[]) => {
    const program = new Command().exitOverride();
    registerAuthoringCommands(program, { action(command, handler) {
      command.action(async (...values: unknown[]) => {
        const cmd = values.at(-1) as InstanceType<typeof Command>;
        await handler({ api, options: { dryRun }, output: value => outputs.push(value), confirm: async () => {
          confirms++; if (rejectConfirmation) throw new Error('확인 필요');
        } } as Parameters<typeof handler>[0], values.slice(0, -2) as string[], cmd.optsWithGlobals());
      });
    } });
    await program.parseAsync(['node', 'clack', 'authoring', ...args]);
  };
  try {
    const file = resolve(dir, 'input.json');
    await writeFile(file, JSON.stringify({ action: 'abandon', session_id: sessionId }));
    await run(['complete', sessionId]); assert.equal(calls, 1); assert.equal(confirms, 0);
    await run(['abandon', sessionId]); assert.equal(calls, 2); assert.equal(confirms, 1);
    await run(['--input', file]); assert.equal(calls, 3); assert.equal(confirms, 2);
    rejectConfirmation = true;
    await assert.rejects(run(['abandon', sessionId]), /확인 필요/); assert.equal(calls, 3);
    dryRun = true;
    await run(['abandon', sessionId]); assert.equal(calls, 3); assert.equal(confirms, 3);
    assert.ok((outputs.at(-1) as { dry_run: boolean }).dry_run);
    await assert.rejects(run(['complete', 'invalid']));
    await assert.rejects(run(['complete', sessionId, '--input', file]));
    await assert.rejects(run([]));
    assert.equal(calls, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
