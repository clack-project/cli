import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command, Option } from 'commander';
import { ApiClient } from '../src/core/api.js';
import { apiError, CliError } from '../src/core/errors.js';
import { ConfigStore, validateBaseUrl, validateToken } from '../src/core/config.js';
import { redact, redactText, rememberSecret } from '../src/core/secrets.js';
import { displayData, formatInstant, requestTimeContract } from '../src/core/time.js';
import { currentToken, parseScopes, pollDevice, registerAuthCommands } from '../src/commands/auth.js';
import { registerConfigCommands } from '../src/commands/config.js';
import type { Runtime, CommandContext } from '../src/core/types.js';

const token = `pat_${'a'.repeat(64)}`;
const response = (body: unknown, status = 200, contract = 'utc-v1') => new Response(JSON.stringify(body), { status, headers: { 'X-CLACK-Time-Contract': contract } });
const mockFetch = (fn: (url: URL, init: RequestInit) => Response | Promise<Response>): typeof fetch => (async (url, init) => fn(new URL(String(url)), init ?? {})) as typeof fetch;

function commandFixture(api: ApiClient) {
  const outputs: unknown[] = [];
  // 실제 cli.ts의 전역 --env·--base-url도 최소한으로 재현해 로그인 원점 불일치 같은 전역 옵션 의존 동작을 검증한다.
  const program = new Command().option('--dry-run')
    .addOption(new Option('--env <environment>', 'API 환경').choices(['prod', 'dev']))
    .option('--base-url <url>', 'API 원점 직접 지정');
  const runtime: Runtime = { action(command, handler) {
    command.action(async (...values: unknown[]) => {
      const cmd = values.at(-1) as Command;
      const ctx: CommandContext = { api, options: cmd.optsWithGlobals(), output: result => { outputs.push(result); }, confirm: async () => {} };
      await handler(ctx, values.slice(0, -2) as string[], cmd.optsWithGlobals());
    });
  } };
  return { outputs, program, runtime };
}

test('토큰 prefix 충돌은 페이지가 나뉘어 있어도 잘못된 권한을 선택하지 않는다', async () => {
  let calls = 0;
  const api = new ApiClient({ baseUrl: 'https://v4-api.clack.kr', token, fetch: mockFetch(() => {
    calls++;
    return response({ data: [{ id: calls, token_prefix: token.slice(0, 12), scopes: [calls === 1 ? 'profile:read' : 'product:write'], expires_at: '2026-10-19T00:00:00.000Z', revoked_at: null, suspended_at: null }],
      pagination: { has_more: calls === 1, next_cursor: calls === 1 ? 1 : null } });
  }) });
  await assert.rejects(currentToken(api, token), { code: 'AMBIGUOUS_TOKEN' });
  assert.equal(calls, 2);
});

test('token list는 다음 커서를 전달하고 잘못된 커서를 요청 전에 거부한다', async () => {
  let calls = 0;
  const api = new ApiClient({ baseUrl: 'https://v4-api.clack.kr', token, fetch: mockFetch(url => {
    calls++;
    assert.equal(url.searchParams.get('cursor'), '50');
    return response({ data: [], pagination: { has_more: false, next_cursor: null } });
  }) });
  const fixture = commandFixture(api);
  registerAuthCommands(fixture.program, fixture.runtime, new ConfigStore());
  await fixture.program.parseAsync(['token', 'list', '--cursor', '50'], { from: 'user' });
  for (const cursor of ['0', '-1', '50abc', '9007199254740992']) {
    const invalid = commandFixture(api);
    registerAuthCommands(invalid.program, invalid.runtime, new ConfigStore());
    await assert.rejects(invalid.program.parseAsync(['token', 'list', '--cursor', cursor], { from: 'user' }), { code: 'VALIDATION_ERROR' });
  }
  assert.equal(calls, 1);
});

test('whoami는 레거시 프로필의 시각을 UTC 결과에 섞지 않는다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-whoami-test-'));
  try {
    const store = new ConfigStore({ CLACK_CONFIG_DIR: directory });
    await store.saveCredential('prod', { token, base_url: 'https://v4-api.clack.kr', scopes: ['profile:read'], expires_at: '2026-10-19T00:00:00.000Z' });
    const api = new ApiClient({ baseUrl: 'https://v4-api.clack.kr', token, fetch: mockFetch((url, init) => {
      if (url.pathname.endsWith('/api-tokens')) return response({ data: [{ id: 1, token_prefix: token.slice(0, 12), scopes: ['profile:read'], expires_at: '2026-10-19T00:00:00.000Z', revoked_at: null, suspended_at: null }] });
      if ((init.headers as Record<string, string>)['X-CLACK-Time-Contract'] === 'utc-v1') return response({ code: 'TIME_CONTRACT_NOT_READY', supported: ['legacy-kst'] }, 406, 'legacy-kst');
      return response({ data: { id: 1, name: '합성', avatar: null, created_at: '2026-09-19T09:00:00.000Z' } }, 200, 'legacy-kst');
    }) });
    const fixture = commandFixture(api);
    registerAuthCommands(fixture.program, fixture.runtime, store);
    await fixture.program.parseAsync(['whoami'], { from: 'user' });
    assert.deepEqual((fixture.outputs[0] as { user: unknown }).user, { id: 1, name: '합성', avatar: null });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('doctor는 서버 메타의 현재 기능·한도를 표시하고 실패를 정상 연결로 숨기지 않는다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-doctor-test-'));
  try {
    const store = new ConfigStore({ CLACK_CONFIG_DIR: directory });
    await store.saveCredential('prod', { token, base_url: 'https://v4-api.clack.kr', scopes: ['product:write'], expires_at: '2026-10-19T00:00:00.000Z' });
    for (const status of [200, 503]) {
      const api = new ApiClient({ baseUrl: 'https://v4-api.clack.kr', token, fetch: mockFetch((url, init) => {
        if (url.pathname.endsWith('/api-tokens')) return response({ data: [{ id: 1, token_prefix: token.slice(0, 12), scopes: ['product:write'], expires_at: '2026-10-19T00:00:00.000Z', revoked_at: null, suspended_at: null }] });
        assert.equal(url.pathname, '/v4/user-api/meta');
        assert.equal((init.headers as Record<string, string>)['X-CLACK-Time-Contract'], 'utc-v1');
        return response(status === 200 ? { data: { limits: { write_per_h: 12 }, features: { write_enabled: false } } } : { code: 'USER_API_DISABLED' }, status);
      }) });
      const fixture = commandFixture(api);
      registerAuthCommands(fixture.program, fixture.runtime, store);
      if (status === 503) {
        await assert.rejects(fixture.program.parseAsync(['doctor'], { from: 'user' }), { code: 'USER_API_DISABLED' });
        assert.deepEqual(fixture.outputs, []);
      } else {
        await fixture.program.parseAsync(['doctor'], { from: 'user' });
        assert.deepEqual((fixture.outputs[0] as { limits: unknown }).limits, { write_per_h: 12 });
        assert.deepEqual((fixture.outputs[0] as { features: unknown }).features, { write_enabled: false });
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('설정 dry-run도 실제 저장과 같은 키·값 검증을 적용하고 파일을 만들지 않는다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-dry-config-test-'));
  try {
    const store = new ConfigStore({ CLACK_CONFIG_DIR: directory });
    for (const [key, value] of [['token', token], ['time', 'invalid'], ['base_url', 'http://outside.example']]) {
      const fixture = commandFixture(new ApiClient({ baseUrl: 'https://v4-api.clack.kr' }));
      registerConfigCommands(fixture.program, fixture.runtime, store);
      await assert.rejects(fixture.program.parseAsync(['config', 'set', key!, value!, '--dry-run'], { from: 'user' }), { code: 'VALIDATION_ERROR' });
    }
    await assert.rejects(readFile(join(directory, 'config.json')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('config env 전환은 저장된 원점을 바꾸고 이전 환경 토큰의 전송을 거부한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-env-test-'));
  try {
    const store = new ConfigStore({ CLACK_CONFIG_DIR: directory });
    await store.saveCredential('prod', { token, base_url: 'https://v4-api.clack.kr', scopes: ['profile:read'], expires_at: '2026-10-19T00:00:00.000Z' });
    await store.setConfig('prod', 'base_url', 'https://v4-api.clack.kr');
    await store.setConfig('prod', 'env', 'dev');
    assert.equal((await store.resolve({}, true)).baseUrl, 'https://v4-api.dev.clack.kr');
    await assert.rejects(store.resolve(), { code: 'TOKEN_ORIGIN_MISMATCH' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('config set env dev 후 login하면 이후 --env dev 유무와 관계없이 같은 dev 자격을 쓴다(D6 i)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-d6-i-test-'));
  try {
    const store = new ConfigStore({ CLACK_CONFIG_DIR: directory });
    // clack config set env dev (프로필 미지정)
    const forConfigSet = await store.resolve({}, true);
    await store.setConfig(forConfigSet.profile, 'env', 'dev');
    // clack login (플래그 없음) — config에 저장된 env로 dev에 연결된다
    const forLogin = await store.resolve({}, true);
    assert.equal(forLogin.baseUrl, 'https://v4-api.dev.clack.kr');
    await store.saveCredential(forLogin.profile, { token, base_url: forLogin.baseUrl, scopes: ['profile:read'], expires_at: '2026-10-19T00:00:00.000Z' });
    await store.setConfig(forLogin.profile, 'base_url', forLogin.baseUrl);
    // clack whoami --env dev
    const withFlag = await store.resolve({ env: 'dev' });
    assert.equal(withFlag.profile, forLogin.profile);
    assert.equal(withFlag.baseUrl, 'https://v4-api.dev.clack.kr');
    assert.equal(withFlag.token, token);
    // clack whoami (플래그 없음)
    const withoutFlag = await store.resolve({});
    assert.equal(withoutFlag.profile, forLogin.profile);
    assert.equal(withoutFlag.baseUrl, 'https://v4-api.dev.clack.kr');
    assert.equal(withoutFlag.token, token);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('사전 config 없이 login --env dev만 해도 이후 명령이 --env dev 유무와 관계없이 같은 dev 자격을 쓴다(D6 ii)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-d6-ii-test-'));
  try {
    const store = new ConfigStore({ CLACK_CONFIG_DIR: directory });
    // clack login --env dev (config set env 없이 바로)
    const forLogin = await store.resolve({ env: 'dev' }, true);
    assert.equal(forLogin.baseUrl, 'https://v4-api.dev.clack.kr');
    await store.saveCredential(forLogin.profile, { token, base_url: forLogin.baseUrl, scopes: ['profile:read'], expires_at: '2026-10-19T00:00:00.000Z' });
    await store.setConfig(forLogin.profile, 'base_url', forLogin.baseUrl);
    // clack whoami (플래그 없음) — 운영 프로필로 조용히 넘어가지 않고 같은 dev 자격을 쓴다
    const withoutFlag = await store.resolve({});
    assert.equal(withoutFlag.profile, forLogin.profile);
    assert.equal(withoutFlag.baseUrl, 'https://v4-api.dev.clack.kr');
    assert.equal(withoutFlag.token, token);
    // clack whoami --env dev
    const withFlag = await store.resolve({ env: 'dev' });
    assert.equal(withFlag.token, token);
    // 명시적으로 다른 환경(prod)을 고르면 그 환경을 따르고, 그 환경의 자격이 없으면 재로그인을 요구한다(예외 조항)
    await assert.rejects(store.resolve({ env: 'prod' }), { code: 'TOKEN_ORIGIN_MISMATCH' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('config set env dev와 login --env dev를 섞어 써도 같은 dev 자격을 쓴다(D6 iii)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-d6-iii-test-'));
  try {
    const store = new ConfigStore({ CLACK_CONFIG_DIR: directory });
    await store.setConfig((await store.resolve({}, true)).profile, 'env', 'dev');
    // 이미 config로 dev를 골라 두고도 login에 --env dev를 중복으로 붙인다
    const forLogin = await store.resolve({ env: 'dev' }, true);
    await store.saveCredential(forLogin.profile, { token, base_url: forLogin.baseUrl, scopes: ['profile:read'], expires_at: '2026-10-19T00:00:00.000Z' });
    await store.setConfig(forLogin.profile, 'base_url', forLogin.baseUrl);
    assert.equal((await store.resolve({})).token, token);
    assert.equal((await store.resolve({ env: 'dev' })).token, token);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('명시적 --profile은 기본 프로필과 분리된 별도 자격을 유지한다(D6, 명시적 --profile)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-d6-profile-test-'));
  try {
    const store = new ConfigStore({ CLACK_CONFIG_DIR: directory });
    const forLogin = await store.resolve({ profile: 'work', env: 'dev' }, true);
    assert.equal(forLogin.profile, 'work');
    await store.saveCredential('work', { token, base_url: forLogin.baseUrl, scopes: ['profile:read'], expires_at: '2026-10-19T00:00:00.000Z' });
    await store.setConfig('work', 'base_url', forLogin.baseUrl);
    // 기본(묵시적) 프로필은 별도이므로 아직 로그인하지 않은 상태다.
    assert.equal((await store.resolve({})).token, undefined);
    // 같은 --profile을 다시 지정하면 --env 없이도 동작한다.
    const explicit = await store.resolve({ profile: 'work' });
    assert.equal(explicit.token, token);
    assert.equal(explicit.baseUrl, 'https://v4-api.dev.clack.kr');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('이전 개발 빌드가 기본 프로필 이름으로 저장한 prod 키도 그대로 이어서 쓴다(D6, 하위 호환)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-d6-legacy-test-'));
  try {
    const store = new ConfigStore({ CLACK_CONFIG_DIR: directory });
    // 이전 빌드의 버그로 dev 자격이 기본 프로필 이름인 'prod'에 저장된 상태를 그대로 재현한다.
    await store.saveCredential('prod', { token, base_url: 'https://v4-api.dev.clack.kr', scopes: ['profile:read'], expires_at: '2026-10-19T00:00:00.000Z' });
    await store.setConfig('prod', 'env', 'dev');
    const resolved = await store.resolve({});
    assert.equal(resolved.token, token);
    assert.equal(resolved.baseUrl, 'https://v4-api.dev.clack.kr');
    // logout 등 삭제 동작이 실제로 이 레거시 버킷을 비운다(다른 키에 쓰고 마는 일이 없어야 한다).
    await store.removeCredential(resolved.profile);
    assert.equal((await store.resolve({})).token, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('login 성공 사람용 출력은 JSON 모양이 아니라 문장형이고 --json은 기존 모양을 유지한다(D9)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-d9-test-'));
  // login --token 경로는 resolve()로 새로 만든 ApiClient(전역 fetch)로 토큰을 확인하므로 전역 fetch를 임시로 바꾼다.
  const originalFetch = globalThis.fetch;
  try {
    const store = new ConfigStore({ CLACK_CONFIG_DIR: directory });
    globalThis.fetch = mockFetch(url => {
      if (url.pathname.endsWith('/api-tokens')) return response({ data: [{ id: 1, token_prefix: token.slice(0, 12), scopes: ['profile:read'], expires_at: '2026-10-19T00:00:00.000Z', revoked_at: null, suspended_at: null }] });
      return response({ data: { id: 1, name: '합성', avatar: null } });
    });
    const fixture = commandFixture(new ApiClient({ baseUrl: 'https://v4-api.clack.kr', token }));
    registerAuthCommands(fixture.program, fixture.runtime, store);
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: unknown) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try { await fixture.program.parseAsync(['login', '--token', token], { from: 'user' }); }
    finally { process.stdout.write = original; }
    const humanOutput = written.join('');
    assert.match(humanOutput, /연결되었습니다\./);
    assert.doesNotMatch(humanOutput.trim(), /^\{/);
    assert.match(humanOutput, /만료: /);
    assert.equal(fixture.outputs.length, 0);
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('logout은 401의 서버 폐기를 확정하지 않고 503·네트워크 실패에는 로컬 토큰을 보존한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-logout-test-'));
  try {
    const store = new ConfigStore({ CLACK_CONFIG_DIR: directory });
    for (const status of [401, 503, 0]) {
      await store.saveCredential('prod', { token, base_url: 'https://v4-api.clack.kr', scopes: ['profile:read'], expires_at: '2026-10-19T00:00:00.000Z' });
      const fixture = commandFixture(new ApiClient({ baseUrl: 'https://v4-api.clack.kr', token, fetch: mockFetch(() => {
        if (!status) throw new Error('연결 끊김');
        return response({ code: status === 401 ? 'PAT_SUSPENDED' : 'USER_API_DISABLED' }, status);
      }) }));
      registerAuthCommands(fixture.program, fixture.runtime, store);
      if (status === 401) {
        await fixture.program.parseAsync(['logout'], { from: 'user' });
        assert.equal((fixture.outputs[0] as { server_revocation_confirmed: boolean }).server_revocation_confirmed, false);
        assert.equal((await store.resolve()).token, undefined);
      } else {
        await assert.rejects(fixture.program.parseAsync(['logout'], { from: 'user' }));
        assert.equal((await store.resolve()).token, token);
        assert.equal(fixture.outputs.length, 0);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('서버가 비밀번호를 오류 본문에 되비추어도 출력 마스킹한다', async () => {
  const secret = '회귀검사용-비밀번호-고유값';
  const api = new ApiClient({ baseUrl: 'https://v4-api.clack.kr', token, fetch: mockFetch(() => response({ message: `거부된 입력: ${secret}` }, 422, 'legacy-kst')) });
  try {
    await api.request('PATCH', '/v4/me/password', { body: { password_confirmation: secret } });
    assert.fail('서버 오류를 전달해야 합니다.');
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.ok(!String(redact(error.message)).includes(secret));
  }
  assert.ok(!JSON.stringify(redact({ [token]: '응답 키' })).includes(token));
});

test('UTC 미준비 조회만 정확한 406 계약을 확인한 후 한 번 재조회한다', async () => {
  const requests: RequestInit[] = [];
  const api = new ApiClient({ baseUrl: 'https://v4-api.clack.kr', token, fetch: mockFetch((_url, init) => {
    requests.push(init);
    return requests.length === 1 ? response({ code: 'TIME_CONTRACT_NOT_READY', supported: ['legacy-kst'] }, 406, 'legacy-kst')
      : response({ data: { created_at: '2026-09-19T09:00:00.000Z' } }, 200, 'legacy-kst');
  }) });
  const result = await api.request('GET', '/v4/me');
  assert.equal(requests.length, 2);
  assert.equal((requests[0]!.headers as Record<string, string>)['X-CLACK-Time-Contract'], 'utc-v1');
  assert.equal((requests[1]!.headers as Record<string, string>)['X-CLACK-Time-Contract'], 'legacy-kst');
  assert.equal(result.time_contract, 'legacy-kst');
});

test('변경 요청은 응답 유실·503·406에서도 재실행하지 않는다', async () => {
  for (const status of [503, 406, 0]) {
    let calls = 0;
    const api = new ApiClient({ baseUrl: 'https://v4-api.clack.kr', token, fetch: mockFetch((_url, init) => {
      calls++;
      assert.equal((init.headers as Record<string, string>)['X-CLACK-Time-Contract'], 'legacy-kst');
      if (!status) throw new Error('비밀 응답');
      return response({ code: 'TIME_CONTRACT_NOT_READY', supported: ['legacy-kst'] }, status, 'legacy-kst');
    }) });
    await assert.rejects(api.request('POST', '/v4/posts', { body: { subject: '본문' } }));
    assert.equal(calls, 1);
  }
});

test('성공 응답의 시간 계약 누락·불일치를 거부한다', async () => {
  for (const contract of ['', 'legacy-kst']) {
    const api = new ApiClient({ baseUrl: 'https://v4-api.clack.kr', token, fetch: mockFetch(() => response({ data: {} }, 200, contract)) });
    await assert.rejects(api.request('GET', '/v4/me'), { code: 'TIME_CONTRACT_MISMATCH' });
  }
});

test('공개 디바이스 요청에는 PAT를 보내지 않고 리다이렉트·dry-run 변경을 차단한다', async () => {
  let calls = 0;
  const api = new ApiClient({ baseUrl: 'https://v4-api.clack.kr', token, fetch: mockFetch((_url, init) => {
    calls++;
    assert.equal((init.headers as Record<string, string>).Authorization, undefined);
    assert.equal(init.redirect, 'error');
    return response({ data: {} });
  }) });
  await api.request('POST', '/v4/auth/device/code', { auth: false, body: {} });
  const dry = new ApiClient({ ...api.settings, dryRun: true });
  await assert.rejects(dry.request('POST', '/v4/images/upload'), { code: 'DRY_RUN_WRITE_BLOCKED' });
  await assert.rejects(api.request('GET', '//attacker.example/v4/me'));
  assert.equal(calls, 1);
});

test('user-api 미배포 응답(전용 라우트 404·디바이스 코드 406)은 USER_API_UNAVAILABLE·종료 코드 8로 매핑하고 무관한 404·406은 그대로 둔다', async () => {
  const meta = new ApiClient({ baseUrl: 'https://v4-api.clack.kr', token,
    fetch: mockFetch(() => response({ code: 'NOT_FOUND', message: '없음' }, 404, '')) });
  await assert.rejects(meta.request('GET', '/v4/user-api/meta'), { code: 'USER_API_UNAVAILABLE', status: 404, exitCode: 8 });

  let deviceCalls = 0;
  const device = new ApiClient({ baseUrl: 'https://v4-api.clack.kr', token, fetch: mockFetch(() => {
    deviceCalls++;
    return response({ code: 'TIME_CONTRACT_NOT_READY', message: '지원하지 않는 시간 계약입니다.', supported: ['legacy-kst'] }, 406, 'legacy-kst');
  }) });
  await assert.rejects(device.request('POST', '/v4/auth/device/code', { auth: false, body: {} }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'USER_API_UNAVAILABLE');
      assert.equal(error.status, 406);
      assert.equal(error.exitCode, 8);
      assert.match(error.message, /clack config set env dev/);
      return true;
    });
  assert.equal(deviceCalls, 1, '변경 요청은 자동 재시도하지 않는다');

  // 일반 리소스 404, user-api가 아닌 경로의 406은 이 매핑의 영향을 받지 않는다.
  const product = new ApiClient({ baseUrl: 'https://v4-api.clack.kr', token,
    fetch: mockFetch(() => response({ code: 'PRODUCT_NOT_FOUND', message: '상품이 없습니다.' }, 404, 'utc-v1')) });
  await assert.rejects(product.request('GET', '/v4/products/999'), { code: 'PRODUCT_NOT_FOUND', status: 404, exitCode: 5 });

  const post = new ApiClient({ baseUrl: 'https://v4-api.clack.kr', token, fetch: mockFetch(() =>
    response({ code: 'TIME_CONTRACT_NOT_READY', message: '지원하지 않습니다.', supported: ['legacy-kst'] }, 406, 'legacy-kst')) });
  await assert.rejects(post.request('POST', '/v4/posts', { body: { subject: '본문' } }), { code: 'TIME_CONTRACT_NOT_READY', status: 406, exitCode: 1 });
});

test('HTTP 상태별 종료 코드와 두 에러 형태·대기 시간을 처리한다', () => {
  for (const [status, expected] of [[401, 3], [403, 4], [423, 4], [404, 5], [400, 6], [409, 6], [422, 6], [429, 7], [500, 1]]) {
    assert.equal(apiError(status!, { message: '오류' }, null).exitCode, expected);
  }
  assert.equal(apiError(503, { success: false, code: 'USER_API_DISABLED', message: '중단' }, null).exitCode, 8);
  assert.equal(apiError(429, { retry_after: 9 }, '4').retryAfter, 9);
  assert.equal(apiError(429, {}, '4').retryAfter, 4);
});

test('스킬 MAJOR 강제 검증 거부는 버전 올리기·취소를 안내하고 입력 오류 종료 코드를 쓴다', () => {
  const error = apiError(409, { code: 'SKILL_VERSION_MAJOR_REQUIRED', message: 'MAJOR 버전을 올려야 합니다.' }, null);
  assert.equal(error.code, 'SKILL_VERSION_MAJOR_REQUIRED');
  assert.equal(error.exitCode, 6);
  assert.match(error.message, /version을 올려 다시 push/);
  assert.match(error.message, /clack skill cancel/);
});

test('서버 키 401은 clack login이 아니라 센터 재발급 안내를 붙인다', () => {
  const serverKey = apiError(401, { code: 'SERVER_KEY_INVALID', message: '유효하지 않은 서버 키입니다.' }, null);
  assert.match(serverKey.message, /센터에서 서버 키/);
  assert.doesNotMatch(serverKey.message, /clack login/);
  const session = apiError(401, { code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' }, null);
  assert.match(session.message, /clack login/);
});

test('KST 가짜 Z와 실제 UTC를 구분하고 달력 날짜를 유지한다', () => {
  assert.equal(formatInstant('2026-09-19T09:00:00.000Z', 'legacy-kst', 'utc'), '2026-09-19T00:00:00.000Z');
  assert.equal(formatInstant('2026-09-19T09:00:00.000Z', 'utc-v1', 'utc'), '2026-09-19T09:00:00.000Z');
  assert.equal(formatInstant('2000-01-01', 'legacy-kst', 'utc'), '2000-01-01');
  assert.equal(requestTimeContract('DELETE', '/v4/posts/1'), 'legacy-kst');
  assert.equal(requestTimeContract('DELETE', '/v4/me/api-tokens/current'), 'utc-v1');
});

test('상품 숨김·삭제 가능·일괄 끌어올리기 시각을 표시하고 본문과 원본은 보존한다', () => {
  const source = { owner_hidden_at: '2026-09-19T09:00:00.000Z', delete_available_at: '2026-09-26T09:00:00.000Z',
    lastBulkBumpedAt: '2026-09-19 09:00:00', birth: '2000-01-01', description: '2026-09-19T09:00:00.000Z' };
  assert.deepEqual(displayData(source, 'legacy-kst', 'utc'), { ...source, owner_hidden_at: '2026-09-19T00:00:00.000Z',
    delete_available_at: '2026-09-26T00:00:00.000Z', lastBulkBumpedAt: '2026-09-19T00:00:00.000Z' });
  assert.equal(source.owner_hidden_at, '2026-09-19T09:00:00.000Z');
  assert.equal(formatInstant(source.lastBulkBumpedAt, 'utc-v1', 'utc'), source.lastBulkBumpedAt);
});

test('비밀값·인증 헤더·중첩 출력·터미널 제어 문자를 가린다', () => {
  rememberSecret('임시비밀값');
  const result = JSON.stringify(redact({ token, token_prefix: token.slice(0, 12), message: `임시비밀값 ${token}\u001b[31m`, nested: [{ password: 'pw', message: 'Bearer secret' }] }));
  assert.ok(!result.includes('a'.repeat(64)));
  assert.ok(!result.includes('임시비밀값'));
  assert.ok(!result.includes('Bearer secret'));
  assert.ok(!result.includes('\\u001b'));
  assert.ok(result.includes(token.slice(0, 12)));
});

test('자격 파일은 0600·원점별로 보관하고 환경변수·명시 설정 순서를 지킨다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-config-test-'));
  try {
    const env = { CLACK_CONFIG_DIR: directory };
    const store = new ConfigStore(env);
    await store.saveCredential('dev', { token, base_url: 'https://v4-api.dev.clack.kr', scopes: ['profile:read'], expires_at: '2026-10-19T00:00:00.000Z' });
    if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'credentials.json'))).mode & 0o777, 0o600);
    assert.equal((await store.resolve({ profile: 'dev' })).token, token);
    await assert.rejects(store.resolve({ profile: 'dev', env: 'prod' }), { code: 'TOKEN_ORIGIN_MISMATCH' });
    const overridden = new ConfigStore({ ...env, CLACK_TOKEN: token, CLACK_API_BASE: 'https://custom.example', CLACK_PROFILE: 'dev' });
    assert.equal((await overridden.resolve()).baseUrl, 'https://custom.example');
    assert.equal((await overridden.resolve({ baseUrl: 'http://127.0.0.1:9000' })).baseUrl, 'http://127.0.0.1:9000');
    await store.removeCredential('dev');
    assert.ok(!(await readFile(join(directory, 'credentials.json'), 'utf8')).includes(token));
    await assert.rejects(store.setConfig('dev', 'token', token));
    await assert.rejects(store.resolve({ profile: '__proto__' }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('자격 파일 심볼릭 링크를 거부한다', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-link-test-'));
  try {
    await symlink(join(directory, 'other.json'), join(directory, 'credentials.json'));
    await assert.rejects(new ConfigStore({ CLACK_CONFIG_DIR: directory }).resolve(), { code: 'CONFIG_UNSAFE' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('토큰·주소·scope 검증은 세션 토큰 및 비보안 외부 주소를 거부한다', () => {
  assert.equal(validateToken(token), token);
  assert.throws(() => validateToken('session-token'));
  for (const value of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/v4', 'ftp://example.com']) assert.throws(() => validateBaseUrl(value));
  assert.deepEqual(parseScopes('profile,product:read,profile:read'), ['profile:read', 'profile:write', 'product:read']);
  assert.throws(() => parseScopes('admin'));
});

test('디바이스 폴링은 최초 간격·SLOW_DOWN 누적·응답 유실 중단을 지킨다', async () => {
  let now = 0;
  const delays: number[] = [];
  let calls = 0;
  const api = new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', fetch: mockFetch(() => {
    calls++;
    if (calls < 3) return response({ code: 'SLOW_DOWN', retry_after: 1 }, 429);
    return response({ data: { token, scopes: ['profile:read'], expires_at: '2026-10-19T00:00:00.000Z', user: { id: 1, name: '합성' } } });
  }) });
  const request = { device_code: `dvc_${'b'.repeat(64)}`, user_code: 'ABCD-2345', verification_uri: 'https://clack.kr/device', verification_uri_complete: 'https://clack.kr/device/ABCD-2345', expires_in: 600, interval: 5 };
  const deps = { now: () => now, sleep: async (ms: number) => { delays.push(ms); now += ms; } };
  assert.equal((await pollDevice(api, request, deps)).token, token);
  assert.deepEqual(delays, [5000, 10000, 15000]);
  let lostCalls = 0;
  const lost = new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', fetch: mockFetch(() => { lostCalls++; throw new Error('연결 끊김'); }) });
  await assert.rejects(pollDevice(lost, request, deps), { code: 'NETWORK_ERROR' });
  assert.equal(lostCalls, 1);
});

test('만료 직전에 새 폴링을 시작하지 않는다', async () => {
  let now = 0;
  const api = new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', fetch: mockFetch(() => { throw new Error('호출되면 실패'); }) });
  await assert.rejects(pollDevice(api, { device_code: 'secret', user_code: 'ABCD-2345', verification_uri: '', verification_uri_complete: '', expires_in: 4, interval: 5 },
    { now: () => now, sleep: async ms => { now += ms; } }), { code: 'EXPIRED_TOKEN' });
});

test('사람용 만료 시각은 로캘·타임존 환경과 무관하게 고정 형식(YYYY-MM-DD HH:MM KST)이다(E9)', () => {
  assert.equal(formatInstant('2026-10-28T09:03:36.000Z', 'utc-v1', 'local'), '2026-10-28 18:03 KST');
  // 자정을 넘어가는 KST 환산(날짜 이월)도 고정 형식으로 정확히 표시한다.
  assert.equal(formatInstant('2026-01-01T15:30:00.000Z', 'utc-v1', 'local'), '2026-01-02 00:30 KST');
  // legacy-kst(가짜 Z)도 같은 고정 형식을 쓴다.
  assert.equal(formatInstant('2026-09-19T09:00:00.000Z', 'legacy-kst', 'local'), '2026-09-19 09:00 KST');
  const output = formatInstant('2026-10-28T09:03:36.000Z', 'utc-v1', 'local');
  // 예전 Intl.DateTimeFormat('ko-KR', {dateStyle, timeStyle})는 실행 환경에 따라 'PM 6시'·'오후 7시'처럼
  // 오전/오후 표기가 갈렸다(E9). 24시간제 숫자만 쓰므로 어떤 오전/오후 표기도 나오지 않아야 한다.
  assert.doesNotMatch(output, /AM|PM|오전|오후/);
});

test('로그인은 대기 중 턴이 끝나도 발급된 요청을 저장해 두어 --resume으로 같은 코드를 이어받아 완료한다(E1, 발급→중단→재개 성공)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-e1-resume-test-'));
  const originalFetch = globalThis.fetch;
  try {
    const store = new ConfigStore({ CLACK_CONFIG_DIR: directory });
    const deviceCode = `dvc_${'c'.repeat(64)}`;
    let issueCalls = 0;
    const issueApi = new ApiClient({ baseUrl: 'https://v4-api.clack.kr', fetch: mockFetch(() => {
      issueCalls++;
      return response({ data: { device_code: deviceCode, user_code: 'ABCD-2345', verification_uri: 'https://clack.kr/device',
        verification_uri_complete: 'https://clack.kr/device/ABCD-2345', expires_in: 600, interval: 5 } });
    }) });
    // 1) 발급 — --no-wait로 코드만 받고 승인은 기다리지 않는다(에이전트가 턴을 끝내는 상황의 재현).
    const issueFixture = commandFixture(issueApi);
    registerAuthCommands(issueFixture.program, issueFixture.runtime, store);
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: unknown) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try { await issueFixture.program.parseAsync(['login', '--no-wait'], { from: 'user' }); }
    finally { process.stdout.write = original; }
    assert.equal(issueCalls, 1);
    assert.match(written.join(''), /clack login --resume/);
    if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'device-request.json'))).mode & 0o777, 0o600);

    // 2) 재개 — 별도 프로세스를 흉내 낸 새 program/runtime이 같은 device_code로 폴링해 완료한다.
    let pollCalls = 0;
    let sentDeviceCode = '';
    globalThis.fetch = mockFetch((_url, init) => {
      pollCalls++;
      sentDeviceCode = JSON.parse(String(init.body)).device_code;
      return response({ data: { token, scopes: ['profile:read'], expires_at: '2026-10-19T00:00:00.000Z', user: { id: 1, name: '합성' } } });
    });
    const resumeFixture = commandFixture(new ApiClient({ baseUrl: 'https://v4-api.clack.kr' }));
    registerAuthCommands(resumeFixture.program, resumeFixture.runtime, store);
    await resumeFixture.program.parseAsync(['login', '--resume'], { from: 'user' });
    assert.equal(issueCalls, 1, '재개는 새 디바이스 코드를 발급하지 않는다');
    assert.equal(pollCalls, 1);
    assert.equal(sentDeviceCode, deviceCode);
    const resolved = await store.resolve({});
    assert.equal(resolved.token, token);
    // 완료 후 대기 요청은 정리되어 남지 않는다.
    assert.equal(await store.getPendingDeviceRequest(resolved.profile), undefined);
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('만료된 뒤 --resume하면 새 요청을 만들지 않고 EXPIRED_TOKEN으로 실패하며 대기 파일을 정리한다(E1, 만료)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-e1-expired-test-'));
  try {
    const store = new ConfigStore({ CLACK_CONFIG_DIR: directory });
    const resolved = await store.resolve({}, true);
    await store.savePendingDeviceRequest(resolved.profile, {
      device_code: `dvc_${'d'.repeat(64)}`, user_code: 'ABCD-2345', verification_uri: 'https://clack.kr/device',
      verification_uri_complete: 'https://clack.kr/device/ABCD-2345', interval: 5, scopes: ['profile:read'],
      base_url: 'https://v4-api.clack.kr', expires_at: new Date(Date.now() - 1000).toISOString(), created_at: new Date(Date.now() - 601_000).toISOString(),
    });
    const noPoll = () => { throw new Error('만료된 요청은 폴링을 호출하면 안 된다'); };
    const fixture = commandFixture(new ApiClient({ baseUrl: 'https://v4-api.clack.kr', fetch: mockFetch(noPoll) }));
    registerAuthCommands(fixture.program, fixture.runtime, store);
    await assert.rejects(fixture.program.parseAsync(['login', '--resume'], { from: 'user' }), { code: 'EXPIRED_TOKEN' });
    assert.equal(await store.getPendingDeviceRequest(resolved.profile), undefined);
    // 정리됐으므로 다시 --resume해도(별도 프로세스를 흉내 낸 새 fixture) 새로 만들지 않고 분명한 코드로 실패한다.
    const retry = commandFixture(new ApiClient({ baseUrl: 'https://v4-api.clack.kr', fetch: mockFetch(noPoll) }));
    registerAuthCommands(retry.program, retry.runtime, store);
    await assert.rejects(retry.program.parseAsync(['login', '--resume'], { from: 'user' }), { code: 'DEVICE_REQUEST_NOT_FOUND' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('디바이스 승인이 거부되면 명확한 코드로 실패하고 대기 요청이 정리되어 다시 --resume해도 자동으로 새 요청을 만들지 않는다(E1, 거부)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-e1-denied-test-'));
  try {
    const store = new ConfigStore({ CLACK_CONFIG_DIR: directory });
    const deviceCode = `dvc_${'e'.repeat(64)}`;
    const api = new ApiClient({ baseUrl: 'https://v4-api.clack.kr', fetch: mockFetch(url => {
      if (url.pathname.endsWith('/device/code')) return response({ data: { device_code: deviceCode, user_code: 'ABCD-2345',
        verification_uri: 'https://clack.kr/device', verification_uri_complete: 'https://clack.kr/device/ABCD-2345', expires_in: 600, interval: 5 } });
      return response({ code: 'ACCESS_DENIED', message: '거부됨' }, 400);
    }) });
    const fixture = commandFixture(api);
    registerAuthCommands(fixture.program, fixture.runtime, store);
    await assert.rejects(fixture.program.parseAsync(['login'], { from: 'user' }), { code: 'ACCESS_DENIED' });
    const resolved = await store.resolve({}, true);
    assert.equal(await store.getPendingDeviceRequest(resolved.profile), undefined);
    const retry = commandFixture(new ApiClient({ baseUrl: 'https://v4-api.clack.kr', fetch: mockFetch(() => { throw new Error('정리된 뒤에는 --resume이 폴링을 호출하면 안 된다'); }) }));
    registerAuthCommands(retry.program, retry.runtime, store);
    await assert.rejects(retry.program.parseAsync(['login', '--resume'], { from: 'user' }), { code: 'DEVICE_REQUEST_NOT_FOUND' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('저장된 요청과 다른 환경을 --env로 명시해 --resume하면 원점 불일치로 실패하고 요청을 그대로 보존한다(E1, 원점 불일치)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-e1-mismatch-test-'));
  try {
    const store = new ConfigStore({ CLACK_CONFIG_DIR: directory });
    const resolved = await store.resolve({}, true);
    await store.savePendingDeviceRequest(resolved.profile, {
      device_code: `dvc_${'1'.repeat(64)}`, user_code: 'ABCD-2345', verification_uri: 'https://dev.clack.kr/device',
      verification_uri_complete: 'https://dev.clack.kr/device/ABCD-2345', interval: 5, scopes: ['profile:read'],
      base_url: 'https://v4-api.dev.clack.kr', expires_at: new Date(Date.now() + 500_000).toISOString(), created_at: new Date().toISOString(),
    });
    const fixture = commandFixture(new ApiClient({ baseUrl: 'https://v4-api.clack.kr', fetch: mockFetch(() => { throw new Error('원점이 다르면 폴링을 호출하면 안 된다'); }) }));
    registerAuthCommands(fixture.program, fixture.runtime, store);
    await assert.rejects(fixture.program.parseAsync(['login', '--resume', '--env', 'prod'], { from: 'user' }), { code: 'DEVICE_REQUEST_ORIGIN_MISMATCH' });
    // 새 요청을 만들지 않고, 저장된 요청도 지우지 않아 올바른 환경으로 다시 --resume하면 이어받을 수 있다.
    assert.ok(await store.getPendingDeviceRequest(resolved.profile));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('저장된 디바이스 요청은 0600으로 보관되고 device_code는 출력·오류 메시지에서 가려진다(E1, 비밀 비노출)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-e1-secret-test-'));
  try {
    const store = new ConfigStore({ CLACK_CONFIG_DIR: directory });
    const deviceCode = `dvc_${'f'.repeat(64)}`;
    const api = new ApiClient({ baseUrl: 'https://v4-api.clack.kr', fetch: mockFetch(() => response({ data: {
      device_code: deviceCode, user_code: 'ABCD-2345', verification_uri: 'https://clack.kr/device',
      verification_uri_complete: 'https://clack.kr/device/ABCD-2345', expires_in: 600, interval: 5 } })) });
    const fixture = commandFixture(api);
    registerAuthCommands(fixture.program, fixture.runtime, store);
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: unknown) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try { await fixture.program.parseAsync(['login', '--no-wait', '--no-qr'], { from: 'user' }); }
    finally { process.stdout.write = original; }
    assert.ok(!written.join('').includes(deviceCode), '표준 출력에 device_code 원문이 노출되면 안 된다');
    if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'device-request.json'))).mode & 0o777, 0o600);
    const raw = await readFile(join(directory, 'device-request.json'), 'utf8');
    assert.ok(raw.includes(deviceCode), '재개를 위해 파일 자체에는 원문이 있어야 한다');
    // 이 값이 다른 경로(예: 오류 메시지 반영)로 다시 나와도 redact가 가려야 한다.
    assert.ok(!redactText(`오류: ${deviceCode}`).includes(deviceCode));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
