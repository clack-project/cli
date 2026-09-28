import { CliError, apiError } from './errors.js';
import { requestTimeContract } from './time.js';
import { rememberSecret, rememberSensitiveValues } from './secrets.js';
import type { ApiResult, TimeContract } from './types.js';
import metadata from '../../package.json' with { type: 'json' };

export const VERSION = metadata.version;
export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Partial<Record<'If-Match' | 'If-None-Match' | 'Idempotency-Key', string>>;
  auth?: boolean;
  contract?: TimeContract;
}
export interface ApiOptions {
  baseUrl: string; token?: string; lang?: string; verbose?: boolean; dryRun?: boolean;
  fetch?: typeof fetch; stderr?: (text: string) => void;
}
export class ApiClient {
  constructor(public readonly settings: ApiOptions) { if (settings.token) rememberSecret(settings.token); }
  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    rememberSensitiveValues(options.body);
    if (!/^\/(?:v4|platform\/v1)\/[a-zA-Z0-9/@_.-]+$/.test(path) || path.includes('//')
      || path.split('/').some((part) => part === '.' || part === '..')) throw new CliError('API 경로가 올바르지 않습니다.');
    if (path.startsWith('/platform/v1/') && !/^csk_[a-f0-9]{64}$/.test(this.settings.token ?? '')) {
      throw new CliError('플랫폼 서버 API에는 CLACK_SERVER_KEY의 서버 키(csk_)가 필요합니다.', 'SERVER_KEY_REQUIRED', 401);
    }
    if (!path.startsWith('/platform/v1/') && this.settings.token?.startsWith('csk_')) {
      throw new CliError('서버 키는 플랫폼 서버 API에만 사용할 수 있습니다.', 'SERVER_KEY_SCOPE_INVALID', 403);
    }
    if (options.headers) {
      const idempotencyKey = options.headers['Idempotency-Key'];
      if (idempotencyKey !== undefined && !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw new CliError('멱등성 키를 확인하세요.', 'VALIDATION_ERROR');
      const match = options.headers['If-Match'];
      const noneMatch = options.headers['If-None-Match'];
      if (match !== undefined && (!/^"[1-9][0-9]*"$/.test(match) || !Number.isSafeInteger(Number(match.slice(1, -1))))
        || noneMatch !== undefined && noneMatch !== '*' || match !== undefined && noneMatch !== undefined) {
        throw new CliError('조건부 쓰기 헤더를 확인하세요.', 'VALIDATION_ERROR');
      }
    }
    if (this.settings.dryRun && method !== 'GET') throw new CliError('dry-run에서는 서버 변경을 실행할 수 없습니다.', 'DRY_RUN_WRITE_BLOCKED');
    if (options.auth !== false && !this.settings.token) throw new CliError('clack login으로 먼저 연결하세요.', 'LOGIN_REQUIRED', 401);
    const url = new URL(path, this.settings.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    let contract = options.contract ?? requestTimeContract(method, path);
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers: Record<string, string> = {
        Accept: 'application/json', 'User-Agent': `clack-cli/${VERSION}`, 'X-Platform': 'cli',
        'X-App-Version': `cli/${VERSION}`, 'x-clack-platform': 'cli', 'X-CLACK-Time-Contract': contract,
        'Accept-Language': this.settings.lang ?? 'ko', 'Cache-Control': 'no-store',
      };
      if (options.auth !== false) headers.Authorization = `Bearer ${this.settings.token}`;
      if (options.headers) Object.assign(headers, options.headers);
      const multipart = options.body instanceof FormData;
      if (options.body !== undefined && !multipart) headers['Content-Type'] = 'application/json';
      if (this.settings.verbose) (this.settings.stderr ?? (s => process.stderr.write(s)))(`${method} ${path} (${contract})\n`);
      let response: Response;
      try {
        response = await (this.settings.fetch ?? fetch)(url, {
          method, headers, body: options.body === undefined ? undefined : multipart ? options.body as FormData : JSON.stringify(options.body),
          redirect: 'error', signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new CliError('API에 연결하지 못했습니다. 변경 요청은 재시도 전에 앱에서 반영 여부를 확인하세요.', 'NETWORK_ERROR', 0);
      }
      const responseContract = response.headers.get('X-CLACK-Time-Contract');
      if (response.ok && response.status === 204) {
        if (responseContract !== contract) throw new CliError('서버의 시간 계약이 요청과 일치하지 않습니다.', 'TIME_CONTRACT_MISMATCH', 0);
        return { data: null as T, time_contract: contract };
      }
      let body: unknown;
      try { body = await response.json(); } catch { throw new CliError('서버가 올바른 JSON을 반환하지 않았습니다.', 'INVALID_RESPONSE', response.status >= 500 ? response.status : 0); }
      const obj = body && typeof body === 'object' ? body as Record<string, unknown> : {};
      if (method === 'GET' && contract === 'utc-v1' && attempt === 0 && response.status === 406
        && obj.code === 'TIME_CONTRACT_NOT_READY' && responseContract === 'legacy-kst'
        && Array.isArray(obj.supported) && obj.supported.includes('legacy-kst')) { contract = 'legacy-kst'; continue; }
      // 외부 도구 연결(user-api)이 이 원점에 아직 배포되지 않은 상태다. 전용 라우트의 404(전체 미배포)와
      // 디바이스 코드 발급의 406 TIME_CONTRACT_NOT_READY(레거시 전용 라우트가 새 스코프를 모름)만
      // 좁게 인식한다. 다른 경로의 일반 404·406은 건드리지 않는다.
      if (!response.ok && ((response.status === 404 && path.startsWith('/v4/user-api/'))
        || (response.status === 406 && path === '/v4/auth/device/code' && obj.code === 'TIME_CONTRACT_NOT_READY'))) {
        throw new CliError(
          `연결한 서버(${this.settings.baseUrl})에서는 외부 도구 연결을 아직 사용할 수 없습니다. 클랙 테스트 앱으로 참여 중이면 \`clack config set env dev\` 후 다시 로그인하세요.`,
          'USER_API_UNAVAILABLE', response.status,
        );
      }
      if (!response.ok) throw apiError(response.status, body, response.headers.get('Retry-After'));
      if (responseContract !== contract) throw new CliError('서버의 시간 계약이 요청과 일치하지 않습니다.', 'TIME_CONTRACT_MISMATCH', 0);
      const cursor = 'next_cursor' in obj && (typeof obj.next_cursor === 'string' || obj.next_cursor === null)
        ? obj.next_cursor : undefined;
      return { data: ('data' in obj ? obj.data : body) as T,
        ...('pagination' in obj ? { pagination: obj.pagination as ApiResult['pagination'] }
          : cursor !== undefined ? { pagination: { next_cursor: cursor, has_more: cursor !== null } } : {}),
        time_contract: contract };
    }
    throw new CliError('시간 계약을 협상하지 못했습니다.', 'TIME_CONTRACT_MISMATCH', 0);
  }
}
