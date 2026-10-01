import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { ApiClient } from '../src/core/api.js';
import type { CommandContext, Runtime } from '../src/core/types.js';
import { registerSkillCommands } from '../src/commands/skill.js';
import { zipSync } from 'fflate';
import { apiError } from '../src/core/errors.js';
import { prepareSkillPackage } from '../src/lib/skill-package.js';

const skillId = '00000000-0000-4000-8000-000000000001';
const versionId = '00000000-0000-4000-8000-000000000002';
const manifest = { manifest_version: 1, name: 'my-skill', version: '1.0.0', type: 'instruction',
  display: { title: { ko: '내 스킬' }, summary: { ko: '제작 지침' }, category: 'story' },
  authoring: { modes: ['agent'], surfaces: ['cli'] }, output: { content_kind: 'html' } };

async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), 'clack-skill-'));
  const dir = join(temp, 'my-skill');
  await mkdir(dir);
  await writeFile(join(dir, 'SKILL.md'), '---\nname: my-skill\ndescription: 제작 지침을 적용합니다\nmetadata:\n  version: 1.0.0\n---\n\n안전하게 제작하세요.\n');
  await writeFile(join(dir, 'clack.skill.json'), JSON.stringify(manifest));
  return { temp, dir };
}

function commandRuntime(ctx: CommandContext): Runtime {
  return { action(command, handler) { command.action(async (...values: unknown[]) => {
    const cmd = values.at(-1) as Command;
    await handler(ctx, values.slice(0, -2) as string[], cmd.opts());
  }); } };
}

test('스킬 디렉터리를 ZIP으로 검사하고 스키마·실행 파일·심볼릭 링크를 거부한다', async () => {
  const { temp, dir } = await fixture();
  try {
    const prepared = await prepareSkillPackage(dir);
    assert.equal(prepared.manifest.name, 'my-skill');
    assert.equal(prepared.file_count, 2);
    assert.equal(prepared.sha256, createHash('sha256').update(prepared.bytes).digest('hex'));
    await new Promise((resolve) => setTimeout(resolve, 2100));
    assert.deepEqual((await prepareSkillPackage(dir)).bytes, prepared.bytes);
    await writeFile(join(dir, 'clack.skill.json'), JSON.stringify({ ...manifest, unsupported: true }));
    await assert.rejects(prepareSkillPackage(dir), /공개 스킬 스키마/);
    await writeFile(join(dir, 'clack.skill.json'), JSON.stringify(manifest));
    await writeFile(join(dir, 'install.sh'), 'exit 0');
    await assert.rejects(prepareSkillPackage(dir), /허용되지 않는 패키지 경로/);
    await rm(join(dir, 'install.sh'));
    await symlink(join(dir, 'SKILL.md'), join(dir, 'linked.md'));
    await assert.rejects(prepareSkillPackage(dir), /허용되지 않는 패키지 경로|일반 파일/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('skill push는 PAT만 쓰고 ZIP 사전검증 → 생성 → presigned PUT → 완료 순서로 동작한다', async () => {
  const { temp, dir } = await fixture();
  const outputs: unknown[] = [];
  const calls: string[] = [];
  const s3Url = 'https://clack-creator-content-dev-123456789012-ap-northeast-2.s3.ap-northeast-2.amazonaws.com/_staging/1/upload?signature=test';
  const apiFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer pat_${'a'.repeat(64)}`);
    const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status,
      headers: { 'Content-Type': 'application/json', 'X-CLACK-Time-Contract': 'utc-v1' } });
    if (url.pathname.endsWith('/validate')) {
      assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/zip');
      return json({ valid: true });
    }
    if (url.pathname === '/v4/creator/skills') return json({ id: skillId, slug: 'my-skill', type: 'instruction' }, 201);
    if (url.pathname.endsWith('/versions')) {
      const body = JSON.parse(String(init?.body)) as { sha256: string; byte_size: number };
      const prepared = await prepareSkillPackage(dir);
      assert.equal(body.sha256, prepared.sha256);
      return json({ version_id: versionId, upload_url: s3Url,
        headers: { 'Content-Type': 'application/zip', 'x-amz-checksum-sha256': createHash('sha256').update(prepared.bytes).digest('base64') },
        expires_at: '2026-09-23T12:00:00.000Z', max_upload_bytes: 10485760 }, 201);
    }
    if (url.pathname.endsWith('/complete')) return json({ id: versionId, skill_id: skillId, version: '1.0.0', review_status: 'validated' });
    throw new Error('예상하지 못한 API');
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), null);
    calls.push('S3 PUT');
    return new Response(null, { status: 200 });
  };
  try {
    const ctx: CommandContext = { api: new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr',
      token: `pat_${'a'.repeat(64)}`, fetch: apiFetch }), options: {}, output: (value) => outputs.push(value),
      confirm: async () => { throw new Error('확인 불필요'); } };
    const program = new Command().exitOverride();
    registerSkillCommands(program, commandRuntime(ctx));
    await program.parseAsync(['skill', 'push', dir], { from: 'user' });
    assert.deepEqual(calls, ['/v4/creator/skills/validate', '/v4/creator/skills',
      `/v4/creator/skills/${skillId}/versions`, 'S3 PUT', `/v4/creator/skills/${skillId}/versions/${versionId}/complete`]);
    assert.deepEqual(outputs, [{ skill_id: skillId, slug: 'my-skill', version_id: versionId,
      version: '1.0.0', review_status: 'validated' }]);
  } finally { globalThis.fetch = originalFetch; await rm(temp, { recursive: true, force: true }); }
});

test('로컬 검증과 dry-run은 인증 없이 동작하고 실제 push는 PAT가 없으면 API 전에 중단한다', async () => {
  const { temp, dir } = await fixture();
  const outputs: unknown[] = [];
  try {
    const ctx: CommandContext = { api: new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr' }),
      options: { dryRun: true }, output: (value) => outputs.push(value), confirm: async () => {} };
    const local = new Command().exitOverride();
    registerSkillCommands(local, commandRuntime(ctx));
    await local.parseAsync(['skill', 'validate', dir], { from: 'user' });
    assert.equal((outputs[0] as { local_valid: boolean }).local_valid, true);
    await local.parseAsync(['skill', 'push', dir], { from: 'user' });
    assert.equal((outputs[1] as { dry_run: boolean }).dry_run, true);
    const actual: CommandContext = { ...ctx, options: {} };
    const real = new Command().exitOverride();
    registerSkillCommands(real, commandRuntime(actual));
    await assert.rejects(real.parseAsync(['skill', 'push', dir], { from: 'user' }), /개인 액세스 토큰/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('skill list는 UUID 커서를 UTC 계약으로 이어서 조회하고 상세·폼·상태를 표시한다', async () => {
  const outputs: unknown[] = [];
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init?.headers).get('X-CLACK-Time-Contract'), 'utc-v1');
    calls.push(`${url.pathname}${url.search}`);
    let body: unknown;
    if (url.pathname === '/v4/skills') body = url.searchParams.has('cursor')
      ? { data: [{ slug: 'second' }], next_cursor: null }
      : { data: [{ slug: 'first' }], next_cursor: skillId };
    else if (url.pathname === '/v4/skills/my-skill') body = { data: { slug: 'my-skill', description: '설명' } };
    else if (url.pathname.endsWith('/form')) body = { data: { skill_id: skillId, version_id: versionId,
      version: '1.0.0', form: { type: 'object' } } };
    else body = { data: { id: versionId, review_status: 'validated' } };
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json',
      'X-CLACK-Time-Contract': 'utc-v1' } });
  };
  const ctx: CommandContext = { api: new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr',
    token: `pat_${'a'.repeat(64)}`, fetch: fetcher }), options: {}, output: (value) => outputs.push(value), confirm: async () => {} };
  async function run(args: string[]) { const program = new Command().exitOverride();
    registerSkillCommands(program, commandRuntime(ctx)); await program.parseAsync(['skill', ...args], { from: 'user' }); }
  await run(['list', '--category', 'story', '--official', 'true', '--all']);
  await run(['get', 'my-skill']);
  await run(['form', 'my-skill', '1.0.0']);
  await run(['status', skillId, versionId]);
  assert.deepEqual((outputs[0] as { data: unknown[] }).data, [{ slug: 'first' }, { slug: 'second' }]);
  assert.ok(calls[0]?.includes('category=story'));
  assert.ok(calls[0]?.includes('official=true'));
  assert.ok(calls[1]?.includes(`cursor=${skillId}`));
  assert.equal((outputs[1] as { data: { slug: string } }).data.slug, 'my-skill');
  assert.equal((outputs[2] as { data: { version: string } }).data.version, '1.0.0');
  assert.equal((outputs[3] as { data: { review_status: string } }).data.review_status, 'validated');
});

test('skill release는 승인 상태를 먼저 확인하고 공개 범위를 확인받으며 cancel은 PAT를 요구한다', async () => {
  let approved = false;
  const calls: string[] = [];
  const confirmations: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method} ${url.pathname}`);
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: { id: versionId, skill_id: skillId,
      version: '1.0.0', review_status: approved ? 'approved' : 'queued', release_status: 'unreleased',
      package_hash: approved ? 'a'.repeat(64) : null } }), { headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
    if (url.pathname.endsWith('/release')) {
      assert.deepEqual(JSON.parse(String(init?.body)), { visibility: 'unlisted' });
      return new Response(JSON.stringify({ data: { review_status: 'approved', visibility: 'unlisted' } }),
        { headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
    }
    return new Response(JSON.stringify({ data: { id: versionId, status: 'cancelled', version_reusable: false } }),
      { headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
  };
  const ctx: CommandContext = { api: new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr',
    token: `pat_${'a'.repeat(64)}`, fetch: fetcher }), options: {}, output: () => {},
    confirm: async (message) => { confirmations.push(message); } };
  async function run(args: string[]) { const program = new Command().exitOverride();
    registerSkillCommands(program, commandRuntime(ctx)); return program.parseAsync(['skill', ...args], { from: 'user' }); }
  await assert.rejects(run(['release', skillId, versionId, '--visibility', 'unlisted']), /승인되고 검증된/);
  assert.equal(calls.length, 1);
  approved = true;
  await run(['release', skillId, versionId, '--visibility', 'unlisted']);
  await run(['cancel', skillId, versionId]);
  assert.equal(confirmations.length, 2);
  assert.equal(calls.filter((call) => call.includes('/release')).length, 1);
  assert.equal(calls.filter((call) => call.includes('/cancel')).length, 1);
});

test('skill submit은 PAT와 검증 상태·해시를 확인한 뒤 명시적 확인 후 제출한다', async () => {
  let reviewStatus = 'queued';
  const calls: string[] = [];
  const confirmations: string[] = [];
  const outputs: unknown[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method} ${url.pathname}`);
    assert.equal(new Headers(init?.headers).get('X-CLACK-Time-Contract'), 'utc-v1');
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: { id: versionId, skill_id: skillId,
      version: '1.0.0', review_status: reviewStatus, release_status: 'unreleased', package_hash: 'a'.repeat(64) } }),
    { headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
    assert.equal(init?.body, undefined);
    return new Response(JSON.stringify({ data: { id: versionId, review_status: 'queued', job_id: skillId,
      package_hash: 'a'.repeat(64), policy_version: 'skill-review-v1' } }),
    { headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
  };
  function context(dryRun = false, token = `pat_${'a'.repeat(64)}`): CommandContext {
    return { api: new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', token, fetch: fetcher, dryRun }),
      options: { dryRun }, output: (value) => outputs.push(value), confirm: async (message) => { confirmations.push(message); } };
  }
  async function run(ctx: CommandContext) {
    const program = new Command().exitOverride();
    registerSkillCommands(program, commandRuntime(ctx));
    await program.parseAsync(['skill', 'submit', skillId, versionId], { from: 'user' });
  }
  await assert.rejects(run(context(false, 'not-a-pat')), /skill:write와 skill:publish/);
  assert.equal(calls.length, 0);
  await assert.rejects(run(context()), /검증 완료 상태/);
  assert.deepEqual(calls, [`GET /v4/creator/skills/${skillId}/versions/${versionId}`]);
  reviewStatus = 'validated';
  await run(context(true));
  assert.equal(confirmations.length, 0);
  assert.deepEqual((outputs[0] as { dry_run: boolean; package_hash: string }).package_hash, 'a'.repeat(64));
  assert.equal(calls.filter((call) => call.startsWith('POST')).length, 0);
  await run(context());
  assert.equal(confirmations.length, 1);
  assert.deepEqual(calls.slice(-2), [`GET /v4/creator/skills/${skillId}/versions/${versionId}`,
    `POST /v4/creator/skills/${skillId}/versions/${versionId}/submit`]);
  assert.equal((outputs[1] as { data: { review_status: string } }).data.review_status, 'queued');
});

test('skill deprecate는 PAT를 요구하고 확인 후 상태를 반환하며 dry-run은 서버를 호출하지 않는다', async () => {
  const calls: string[] = [];
  const confirmations: string[] = [];
  const outputs: unknown[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method} ${url.pathname}`);
    return new Response(JSON.stringify({ data: { id: skillId, slug: 'my-skill', status: 'deprecated' } }),
      { headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
  };
  function context(dryRun = false, token = `pat_${'a'.repeat(64)}`): CommandContext {
    return { api: new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', token, fetch: fetcher, dryRun }),
      options: { dryRun }, output: (value) => outputs.push(value), confirm: async (message) => { confirmations.push(message); } };
  }
  async function run(ctx: CommandContext) {
    const program = new Command().exitOverride();
    registerSkillCommands(program, commandRuntime(ctx));
    await program.parseAsync(['skill', 'deprecate', skillId], { from: 'user' });
  }
  // 서버는 지원 종료에 skill:publish를 요구한다. skill:write로 안내하면 권한을 잘못 받아 403이 난다.
  await assert.rejects(run(context(false, 'not-a-pat')), (error: Error) =>
    /skill:publish/.test(error.message) && !/skill:write/.test(error.message));
  assert.equal(calls.length, 0);
  await run(context(true));
  assert.equal(confirmations.length, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(outputs[0], { dry_run: true, method: 'POST', path: `/v4/creator/skills/${skillId}/deprecate` });
  await run(context());
  assert.equal(confirmations.length, 1);
  assert.deepEqual(calls, [`POST /v4/creator/skills/${skillId}/deprecate`]);
  assert.equal((outputs[1] as { data: { status: string } }).data.status, 'deprecated');
});

test('버전 경로의 점은 허용하되 경로 탐색은 요청 전에 차단한다', async () => {
  let called = false;
  const client = new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', token: `pat_${'a'.repeat(64)}`,
    fetch: async () => { called = true; return new Response('{}'); } });
  await assert.rejects(client.request('GET', '/v4/skills/my-skill/../private'), /API 경로/);
  assert.equal(called, false);
});

// 공식 캐릭터챗 2.2.1 폼은 x-clack-help-i18n·x-clack-placeholder-i18n 형제 키를 쓴다. 모노레포가 없으면 건너뛴다.
const monorepo = process.env.CLACK_MONOREPO_DIR ?? '../clack';
test('공식 캐릭터챗 2.2.1 폼(다국어 안내·자리표시 키)을 로컬 검사가 통과시킨다', { skip: !existsSync(join(monorepo, 'clack-api-v4/skills/clack-character-chat/2.2.1')) }, async () => {
  const prepared = await prepareSkillPackage(join(monorepo, 'clack-api-v4/skills/clack-character-chat/2.2.1'));
  assert.equal(prepared.manifest.name, 'clack-character-chat');
  assert.equal(prepared.manifest.version, '2.2.1');
});

// 2.2.2 매니페스트는 display에 description·tags_i18n·release_notes를 더한다. tags_i18n은 tags가 있어야 한다.
test('display 다국어 키(description·tags_i18n·release_notes)를 허용하고 tags 없는 tags_i18n은 거부한다', async () => {
  const { temp, dir } = await fixture();
  try {
    const display = { ...manifest.display, title: { ko: '캐릭터 챗 만들기', en: 'Create a character chat' },
      description: { ko: '자세한 소개', en: 'Details' }, tags: ['캐릭터', '대화'], tags_i18n: { en: ['Character', 'Chat'] },
      release_notes: { ko: '2.2.2: 영어로도 보여 줘요.', en: '2.2.2: Now available in English.' } };
    await writeFile(join(dir, 'clack.skill.json'), JSON.stringify({ ...manifest, display }));
    assert.equal((await prepareSkillPackage(dir)).manifest.name, 'my-skill');
    const { tags: _tags, ...withoutTags } = display;
    await writeFile(join(dir, 'clack.skill.json'), JSON.stringify({ ...manifest, display: withoutTags }));
    await assert.rejects(prepareSkillPackage(dir), /공개 스킬 스키마/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

const skillMd = '---\nname: my-skill\ndescription: 제작 지침을 적용합니다\nmetadata:\n  version: 1.0.0\n---\n\n안전하게 제작하세요.\n';
const enc = (text: string) => new TextEncoder().encode(text);
const cleanFiles = () => ({ 'SKILL.md': enc(skillMd), 'clack.skill.json': enc(JSON.stringify(manifest)) });
async function zipFixture(files: Record<string, Uint8Array>) {
  const temp = await mkdtemp(join(tmpdir(), 'clack-skill-zip-'));
  const path = join(temp, 'skill.zip');
  await writeFile(path, zipSync(files));
  return { temp, path };
}

test('ZIP의 부가 파일(__MACOSX·.DS_Store·._*)은 무시하고 깨끗한 패키지와 같은 결과를 낸다', async () => {
  const clean = await zipFixture(cleanFiles());
  const dirty = await zipFixture({ ...cleanFiles(), '.DS_Store': enc('x'), '._SKILL.md': enc('x'), '__MACOSX/._SKILL.md': enc('x'),
    '__MACOSX/._clack.skill.json': enc('x') });
  try {
    const a = await prepareSkillPackage(clean.path);
    const b = await prepareSkillPackage(dirty.path);
    assert.equal(b.file_count, a.file_count);
    assert.equal(b.total_bytes, a.total_bytes);
    assert.equal(b.manifest.name, 'my-skill');
  } finally { await rm(clean.temp, { recursive: true, force: true }); await rm(dirty.temp, { recursive: true, force: true }); }
});

test('ZIP의 바깥 폴더 한 겹은 벗기고 두 겹·조건 불충족은 거부한다', async () => {
  const wrapped = await zipFixture({ 'my-skill/SKILL.md': enc(skillMd), 'my-skill/clack.skill.json': enc(JSON.stringify(manifest)),
    'my-skill/.DS_Store': enc('x'), '__MACOSX/my-skill/._SKILL.md': enc('x') });
  const double = await zipFixture({ 'a/my-skill/SKILL.md': enc(skillMd), 'a/my-skill/clack.skill.json': enc(JSON.stringify(manifest)) });
  const partial = await zipFixture({ 'my-skill/SKILL.md': enc(skillMd), 'my-skill/clack.skill.json': enc(JSON.stringify(manifest)), 'README.md': enc('x') });
  try {
    const prepared = await prepareSkillPackage(wrapped.path);
    assert.equal(prepared.file_count, 2);
    await assert.rejects(prepareSkillPackage(double.path), /SKILL\.md와 clack\.skill\.json/);
    await assert.rejects(prepareSkillPackage(partial.path), /SKILL\.md와 clack\.skill\.json/);
  } finally { for (const f of [wrapped, double, partial]) await rm(f.temp, { recursive: true, force: true }); }
});

test('__MACOSX는 맨 위 구성요소일 때만 부가 파일이고 하위 폴더의 __MACOSX는 패키지에 남는다', async () => {
  const nested = await zipFixture({ ...cleanFiles(), 'references/__MACOSX/x.md': enc('x') });
  const wrapped = await zipFixture({ 'w/SKILL.md': enc(skillMd), 'w/clack.skill.json': enc(JSON.stringify(manifest)), 'w/__MACOSX/x': enc('x') });
  const { temp, dir } = await fixture();
  try {
    assert.equal((await prepareSkillPackage(nested.path)).file_count, 3);
    // 바깥 폴더를 벗긴 뒤 맨 위에 오는 __MACOSX는 부가 파일이 아니라 `__` 시작 경로 거부다.
    await assert.rejects(prepareSkillPackage(wrapped.path), /허용되지 않는 ZIP 경로/);
    await mkdir(join(dir, 'references', '__MACOSX'), { recursive: true });
    await writeFile(join(dir, 'references', '__MACOSX', 'x.md'), 'x');
    assert.equal((await prepareSkillPackage(dir)).file_count, 3);
  } finally { for (const f of [nested, wrapped]) await rm(f.temp, { recursive: true, force: true }); await rm(temp, { recursive: true, force: true }); }
});

test('ZIP 항목 수와 실파일 수 한도: 부가 파일은 실파일에 세지 않고 원시 항목 2,000개 초과는 거부한다', async () => {
  const files = cleanFiles() as Record<string, Uint8Array>;
  for (let i = 0; i < 1998; i++) files[`__MACOSX/._${i}`] = enc('x');
  const ok = await zipFixture(files);
  const tooMany = await zipFixture({ ...files, '__MACOSX/._extra': enc('x') });
  try {
    assert.equal((await prepareSkillPackage(ok.path)).file_count, 2);
    await assert.rejects(prepareSkillPackage(tooMany.path), /2,000개/);
  } finally { for (const f of [ok, tooMany]) await rm(f.temp, { recursive: true, force: true }); }
});

async function pushWithCompleteFailure(status: number, body: unknown) {
  const { temp, dir } = await fixture();
  const prepared = await prepareSkillPackage(dir);
  const apiFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const json = (data: unknown, code = 200) => new Response(JSON.stringify({ data }), { status: code,
      headers: { 'Content-Type': 'application/json', 'X-CLACK-Time-Contract': 'utc-v1' } });
    if (url.pathname.endsWith('/validate')) return json({ valid: true });
    if (url.pathname === '/v4/creator/skills') return json({ id: skillId, slug: 'my-skill', type: 'instruction' }, 201);
    if (url.pathname.endsWith('/versions')) return json({ version_id: versionId, upload_url: 'https://clack-creator-content-dev-123456789012-ap-northeast-2.s3.ap-northeast-2.amazonaws.com/_staging/1/upload?signature=test',
      headers: { 'Content-Type': 'application/zip', 'x-amz-checksum-sha256': createHash('sha256').update(prepared.bytes).digest('base64') },
      expires_at: '2026-09-23T12:00:00.000Z', max_upload_bytes: 10485760 }, 201);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-CLACK-Time-Contract': 'utc-v1' } });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 200 });
  try {
    const ctx: CommandContext = { api: new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', token: `pat_${'a'.repeat(64)}`, fetch: apiFetch }),
      options: {}, output: () => {}, confirm: async () => {} };
    const program = new Command().exitOverride();
    registerSkillCommands(program, commandRuntime(ctx));
    return await program.parseAsync(['skill', 'push', dir], { from: 'user' }).then(() => '', (error: Error) => error.message);
  } finally { globalThis.fetch = originalFetch; await rm(temp, { recursive: true, force: true }); }
}

test('complete 실패 안내: 4xx 판정 실패는 같은 버전 재push, 5xx·429는 완료 재시도를 안내하고 details 위치를 보존한다', async () => {
  const invalidBody = { code: 'AUTHORING_FORM_INVALID', message: '제작 폼을 확인해 주세요.',
    details: { reason: 'form_schema', file: 'form/character.schema.json', issues: [{ pointer: '/properties/rating', rule: 'required', param: 'maxLength' }] } };
  const m422 = await pushWithCompleteFailure(422, invalidBody);
  assert.match(m422, /form\/character\.schema\.json/);
  assert.match(m422, /\/properties\/rating/);
  assert.match(m422, /같은 버전으로 다시 clack skill push/);
  assert.doesNotMatch(m422, /완료 재시도/);
  const m400 = await pushWithCompleteFailure(400, { code: 'SKILL_MANIFEST_INVALID', message: '유형이 달라요.',
    details: { reason: 'type_mismatch', expected: 'template', actual: 'instruction' } });
  assert.match(m400, /type_mismatch/);
  assert.match(m400, /기대: template \/ 실제: instruction/);
  assert.match(m400, /같은 버전으로 다시 clack skill push/);
  for (const status of [503, 429]) {
    const message = await pushWithCompleteFailure(status, { code: 'TEMPORARY', message: '잠시 후 다시 시도해 주세요.' });
    assert.match(message, /완료 재시도: clack skill complete/);
    assert.doesNotMatch(message, /다시 clack skill push/);
  }
});

test('부가 파일 아래의 위험 경로와 그 밖의 숨김 파일은 계속 거부하고 파일 수는 부가 파일을 뺀 실파일로 센다', async () => {
  const traversal = await zipFixture({ ...cleanFiles(), '__MACOSX/../x': enc('x') });
  const git = await zipFixture({ ...cleanFiles(), '.git/config': enc('x') });
  const env = await zipFixture({ ...cleanFiles(), '.env': enc('x') });
  const files = cleanFiles() as Record<string, Uint8Array>;
  for (let i = 0; i < 497; i++) files[`references/f${i}.md`] = enc('x');
  const junk = { ...files } as Record<string, Uint8Array>;
  for (let i = 0; i < 497; i++) junk[`references/._f${i}.md`] = enc('x');
  const ok = await zipFixture(junk);
  try {
    for (const f of [traversal, git, env]) await assert.rejects(prepareSkillPackage(f.path), /허용되지 않는 ZIP 경로/);
    assert.equal((await prepareSkillPackage(ok.path)).file_count, 499);
  } finally { for (const f of [traversal, git, env, ok]) await rm(f.temp, { recursive: true, force: true }); }
});

test('폴더 모드도 부가 파일을 건너뛰고 그 밖의 숨김 파일은 거부한다', async () => {
  const { temp, dir } = await fixture();
  try {
    await writeFile(join(dir, '.DS_Store'), 'x');
    await writeFile(join(dir, '._SKILL.md'), 'x');
    await mkdir(join(dir, '__MACOSX'));
    await writeFile(join(dir, '__MACOSX', '._SKILL.md'), 'x');
    assert.equal((await prepareSkillPackage(dir)).file_count, 2);
    await writeFile(join(dir, '.env'), 'x');
    await assert.rejects(prepareSkillPackage(dir), /허용되지 않는 패키지 경로/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('서버 오류의 details를 위치와 함께 출력하고 없거나 이상한 모양에도 안전하다', () => {
  const error = apiError(422, { code: 'AUTHORING_FORM_INVALID', message: '제작 폼을 확인해 주세요.',
    details: { reason: 'form_schema', file: 'form/character.schema.json',
      issues: [{ pointer: '/properties/rating', rule: 'required', param: 'maxLength' }], expected: 'a', actual: 'b' } }, null);
  for (const text of ['form_schema', 'form/character.schema.json', '/properties/rating', 'required', 'maxLength', '기대: a / 실제: b']) {
    assert.ok(error.message.includes(text), text);
  }
  assert.equal(apiError(422, { code: 'X', message: '실패' }, null).message, '실패');
  assert.equal(apiError(422, { code: 'X', message: '실패', details: 'bad' }, null).message, '실패');
  assert.equal(apiError(422, { code: 'X', message: '실패', details: { issues: [null, 3, {}] } }, null).message, '실패');
});
