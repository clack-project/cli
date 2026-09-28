import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { password } from '@inquirer/prompts';
import { Command } from 'commander';
import open from 'open';
import qr from 'qrcode-terminal';
import { ApiClient, VERSION } from '../core/api.js';
import { ConfigStore, validateToken, type Credential } from '../core/config.js';
import { CliError } from '../core/errors.js';
import { redactText, rememberSecret } from '../core/secrets.js';
import { formatInstant } from '../core/time.js';
import type { Runtime } from '../core/types.js';

export const SCOPES = ['profile:read', 'profile:write', 'product:read', 'product:write', 'content:read', 'content:write', 'creator-content:read', 'creator-content:write', 'creator-content:publish', 'skill:read', 'skill:write', 'skill:publish', 'platform:read', 'platform:write', 'custom-page:read', 'custom-page:write', 'custom-page:publish'];
export function parseScopes(raw: string): string[] {
  const values = [...new Set(raw.split(',').flatMap(value => {
    const item = value.trim();
    return ['profile', 'product', 'content', 'creator-content', 'skill', 'platform', 'custom-page'].includes(item) ? [`${item}:read`, `${item}:write`] : [item];
  }))];
  if (!values.length || values.some(value => !SCOPES.includes(value))) throw new CliError('scope는 profile, product, content, creator-content, skill, platform, custom-page의 :read/:write 또는 creator-content:publish, skill:publish, custom-page:publish 권한이어야 합니다.');
  return values;
}
interface TokenRow { id: number; token_prefix: string; scopes: string[]; expires_at: string; revoked_at: string | null; suspended_at: string | null; }

export async function currentToken(api: ApiClient, token: string): Promise<TokenRow | undefined> {
  let cursor: string | number | undefined;
  let matched: TokenRow | undefined;
  const seen = new Set<string>();
  do {
    const result = await api.request<TokenRow[]>('GET', '/v4/me/api-tokens', { query: { cursor } });
    if (!Array.isArray(result.data)) throw new CliError('토큰 목록 응답을 확인할 수 없습니다.', 'INVALID_RESPONSE', 0);
    const match = result.data.filter(row => row.token_prefix === token.slice(0, 12) && !row.revoked_at && !row.suspended_at);
    if (match.length > 1 || matched && match.length) throw new CliError('현재 토큰을 구분하지 못했습니다. 앱에서 새 토큰을 발급하세요.', 'AMBIGUOUS_TOKEN', 401);
    if (match[0]) matched = match[0];
    if (result.pagination?.has_more && result.pagination.next_cursor == null) throw new CliError('토큰 목록의 다음 커서가 없습니다.', 'INVALID_RESPONSE', 0);
    cursor = result.pagination?.has_more ? result.pagination.next_cursor ?? undefined : undefined;
    if (cursor !== undefined && seen.has(String(cursor))) throw new CliError('토큰 목록 커서가 반복됩니다.', 'INVALID_RESPONSE', 0);
    if (cursor !== undefined) seen.add(String(cursor));
  } while (cursor !== undefined);
  return matched;
}

interface DeviceRequest { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number; }
interface DeviceGrant { token: string; expires_at: string; scopes: string[]; user: NonNullable<Credential['user']>; }

export async function pollDevice(api: ApiClient, request: DeviceRequest, deps = {
  now: () => Date.now(), sleep: (ms: number) => delay(ms),
}): Promise<DeviceGrant> {
  const deadline = deps.now() + request.expires_in * 1000;
  let interval = Math.max(5, request.interval);
  while (deps.now() < deadline) {
    await deps.sleep(Math.min(interval * 1000, deadline - deps.now()));
    if (deps.now() >= deadline) break;
    try {
      return (await api.request<DeviceGrant>('POST', '/v4/auth/device/token', { auth: false, body: { device_code: request.device_code } })).data;
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      if (error.code === 'AUTHORIZATION_PENDING') continue;
      if (error.code === 'SLOW_DOWN') { interval = Math.max(interval + 5, error.retryAfter ?? 0); continue; }
      // 교부 응답 유실은 자동 재시도하지 않는다. 서버는 원문을 한 번만 반환한다.
      throw error;
    }
  }
  throw new CliError('승인 코드가 만료되었습니다. clack login을 다시 실행하세요.', 'EXPIRED_TOKEN', 410);
}

async function tokenInput(option: string | boolean | undefined): Promise<string> {
  if (typeof option === 'string') return validateToken(option);
  if (process.env.CLACK_TOKEN) return validateToken(process.env.CLACK_TOKEN);
  if (process.stdin.isTTY) return validateToken(await password({ message: '개인 액세스 토큰', mask: '*' }));
  let value = '';
  for await (const chunk of process.stdin) {
    value += String(chunk);
    if (value.length > 256) throw new CliError('토큰 입력이 너무 깁니다.', 'INVALID_TOKEN');
  }
  return validateToken(value);
}

export function registerAuthCommands(program: Command, runtime: Runtime, store: ConfigStore): void {
  runtime.action(program.command('login').description('앱에서 승인하거나 개인 액세스 토큰으로 연결')
    .option('--token [pat]', '토큰 입력. 값을 생략하면 숨김 프롬프트 또는 표준 입력 사용')
    .option('--scopes <scopes>', '요청 권한 (쉼표 구분)', 'profile:read')
    .option('--no-browser', '브라우저 자동 열기 생략').option('--no-qr', 'QR 코드 출력 생략 (에이전트·비대화형 환경에 적합)')
    .option('--label <name>', '기기 이름', hostname()), async (ctx, _args, opts) => {
    if (ctx.options.dryRun) throw new CliError('login은 --dry-run을 지원하지 않습니다.');
    const resolved = await store.resolve(ctx.options, true);
    let credential: Credential;
    if (opts.token !== undefined || process.env.CLACK_TOKEN) {
      const token = await tokenInput(opts.token);
      const api = new ApiClient({ baseUrl: resolved.baseUrl, token, verbose: ctx.options.verbose });
      const row = await currentToken(api, token);
      if (!row) throw new CliError('발급된 토큰이 아직 목록에 없습니다. 잠시 후 다시 연결하세요.', 'TOKEN_NOT_VISIBLE', 401);
      credential = { token, base_url: resolved.baseUrl, scopes: row.scopes, expires_at: row.expires_at, token_id: row.id };
      if (row.scopes.includes('profile:read')) {
        const result = await api.request<NonNullable<Credential['user']>>('GET', '/v4/me');
        credential.user = { id: result.data.id, name: result.data.name, avatar: result.data.avatar };
      }
    } else {
      const scopes = parseScopes(opts.scopes);
      if (typeof opts.label !== 'string' || !opts.label.trim() || opts.label.length > 120) throw new CliError('기기 이름은 1~120자여야 합니다.');
      const { data: request } = await ctx.api.request<DeviceRequest>('POST', '/v4/auth/device/code', { auth: false, body: {
        client_name: 'cli', client_version: VERSION, device_name: opts.label, scopes,
      } });
      rememberSecret(request.device_code);
      if (!/^dvc_[a-f0-9]{64}$/.test(request.device_code) || !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(request.user_code)
        || !Number.isFinite(request.expires_in) || request.expires_in <= 0 || request.expires_in > 600
        || !Number.isFinite(request.interval) || request.interval < 1) throw new CliError('승인 요청 응답이 올바르지 않습니다.', 'INVALID_RESPONSE', 0);
      const verification = new URL(request.verification_uri_complete);
      if (verification.protocol !== 'https:' || !['clack.kr', 'dev.clack.kr', 'www.clack.kr'].includes(verification.hostname)
        || verification.username || verification.password || verification.port) throw new CliError('승인 페이지 주소가 올바르지 않습니다.', 'INVALID_RESPONSE', 0);
      process.stderr.write(redactText(`앱 마이페이지 → 계정 → 내 정보 수정하기 → 외부 도구 연결 → 코드로 승인에서 ${request.user_code} 입력\n${verification.href}\n`));
      if (opts.qr !== false && process.stderr.isTTY && !ctx.options.json) qr.generate(verification.href, { small: true }, value => process.stderr.write(value + '\n'));
      if (opts.browser && process.stdin.isTTY && !ctx.options.json) await open(verification.href).catch(() => process.stderr.write('브라우저를 열지 못했습니다. 위 주소나 앱에서 승인하세요.\n'));
      const grant = await pollDevice(ctx.api, request);
      const token = validateToken(grant.token);
      if (!Array.isArray(grant.scopes) || grant.scopes.some(scope => !scopes.includes(scope)) || !Number.isFinite(Date.parse(grant.expires_at))
        || !grant.user || !Number.isSafeInteger(grant.user.id)) throw new CliError('교부 응답이 올바르지 않습니다. 앱에서 연결 목록을 확인하세요.', 'INVALID_RESPONSE', 0);
      credential = { token, base_url: resolved.baseUrl, scopes: grant.scopes, expires_at: grant.expires_at, user: grant.user };
    }
    await store.saveCredential(resolved.profile, credential);
    await store.setConfig(resolved.profile, 'base_url', resolved.baseUrl);
    if (ctx.options.json) {
      ctx.output({ profile: resolved.profile, user: credential.user ?? null, scopes: credential.scopes, expires_at: credential.expires_at, message: '연결되었습니다.' });
    } else {
      // 사람용 출력은 JSON을 그대로 찍지 않고 다른 명령과 같은 --time 규칙으로 만료 시각을 표시한다.
      const expiry = formatInstant(credential.expires_at, 'utc-v1', ctx.options.time ?? 'local');
      process.stdout.write(redactText([
        `연결되었습니다. (프로필: ${resolved.profile}, 주소: ${resolved.baseUrl})`,
        credential.user ? `사용자: ${credential.user.name ?? '이름 없음'} (#${credential.user.id})` : '사용자: profile:read 권한이 없어 조회하지 않음',
        `권한: ${credential.scopes.join(', ')}`,
        `만료: ${expiry}`,
      ].join('\n') + '\n'));
    }
  });
  runtime.action(program.command('logout').description('현재 토큰을 서버에서 폐기하고 로컬 연결 삭제'), async (ctx) => {
    const resolved = await store.resolve(ctx.options);
    if (ctx.options.dryRun) { ctx.output({ action: 'logout', dry_run: true }); return; }
    let serverRevocationConfirmed = true;
    try { await ctx.api.request('DELETE', '/v4/me/api-tokens/current'); }
    catch (error) {
      if (!(error instanceof CliError) || error.status !== 401) throw error;
      serverRevocationConfirmed = false;
    }
    // 환경 토큰과 저장된 토큰이 다르면 별개 연결을 지우지 않는다.
    if (!resolved.tokenFromEnv || resolved.credential?.token === resolved.token) await store.removeCredential(resolved.profile);
    const message = serverRevocationConfirmed
      ? resolved.tokenFromEnv ? '토큰이 폐기되었습니다. CLACK_TOKEN 환경변수도 삭제하세요.' : '연결을 해제했습니다.'
      : `서버 폐기를 확인하지 못했습니다. 앱 마이페이지 → 계정 → 내 정보 수정하기 → 외부 도구 연결에서 토큰 상태를 확인하고 폐기하세요.${resolved.tokenFromEnv ? ' CLACK_TOKEN 환경변수도 삭제하세요.' : ' 로컬 연결은 삭제했습니다.'}`;
    ctx.output({ server_revocation_confirmed: serverRevocationConfirmed, message });
  });
  for (const name of ['whoami', 'doctor']) runtime.action(program.command(name).description('현재 연결·권한·만료 확인'), async ctx => {
    const resolved = await store.resolve(ctx.options);
    if (!resolved.token) throw new CliError('clack login으로 먼저 연결하세요.', 'LOGIN_REQUIRED', 401);
    const row = await currentToken(ctx.api, resolved.token);
    if (!row) throw new CliError('현재 토큰이 아직 목록에 없습니다. 잠시 후 다시 확인하세요.', 'TOKEN_NOT_VISIBLE', 401);
    const profile = row.scopes.includes('profile:read') ? (await ctx.api.request<NonNullable<Credential['user']>>('GET', '/v4/me')).data : null;
    // 신원 필드만 포함해 프로필의 레거시 시각과 토큰의 실제 UTC 시각을 섞지 않는다.
    const user = profile ? { id: profile.id, name: profile.name, avatar: profile.avatar } : null;
    const meta = name === 'doctor'
      ? (await ctx.api.request<{ limits: unknown; features: unknown }>('GET', '/v4/user-api/meta')).data : null;
    ctx.output({ profile: resolved.profile, base_url: resolved.baseUrl, version: VERSION, user, token: undefined,
      token_id: row?.id ?? null, scopes: row?.scopes ?? [], expires_at: row?.expires_at ?? null,
      ...(name === 'doctor' ? { connected: true, limits: meta?.limits, features: meta?.features } : {}) });
  });
  const tokens = program.command('token').description('내 연결 토큰 관리');
  runtime.action(tokens.command('list').option('--cursor <id>', '다음 페이지 커서 (페이지당 최대 50개)'), async (ctx, _args, opts) => {
    if (opts.cursor !== undefined && (!/^[1-9][0-9]*$/.test(opts.cursor) || !Number.isSafeInteger(Number(opts.cursor)))) throw new CliError('커서는 양의 정수여야 합니다.');
    ctx.output(await ctx.api.request('GET', '/v4/me/api-tokens', { query: { cursor: opts.cursor } }));
  });
  runtime.action(tokens.command('revoke <id>'), async (ctx, [id]) => {
    if (!/^[1-9][0-9]*$/.test(id!) || !Number.isSafeInteger(Number(id))) throw new CliError('토큰 ID를 확인하세요.');
    await ctx.confirm(`토큰 ${id} 연결을 폐기할까요?`);
    if (ctx.options.dryRun) { ctx.output({ action: 'token.revoke', id, dry_run: true }); return; }
    ctx.output(await ctx.api.request('DELETE', `/v4/me/api-tokens/${id}`));
  });
}
