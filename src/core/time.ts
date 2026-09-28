import type { TimeContract } from './types.js';

/** CLI에서 사용하는 준비된 조회 경로만 협상한다. 변경 요청은 신규 UTC 표면 외에는 레거시다. */
export function requestTimeContract(method: string, path: string): TimeContract {
  if (/^\/platform\/v1(?:\/|$)/.test(path)) return 'utc-v1';
  if (/^\/v4\/creator(?:\/|$)/.test(path)) return 'utc-v1';
  if (/^\/v4\/skills(?:\/|$)/.test(path)) return 'utc-v1';
  if (path === '/v4/user-api/meta') return 'utc-v1';
  if (/^\/v4\/me\/api-tokens(?:\/|$)/.test(path) || /^\/v4\/auth\/device\//.test(path)) return 'utc-v1';
  if (method !== 'GET') return 'legacy-kst';
  if (['/v4/me', '/v4/me/posts', '/v4/me/addresses', '/v4/me/bookmarks', '/v4/me/channel', '/v4/me/channel-posts',
    '/v4/me/channel-subscriptions', '/v4/merchandises/mine', '/v4/merchandises/with-post', '/v4/merchandises/without-post',
    '/v4/my/bulk-bump/status', '/v4/merchandises/my/bulk-bump/status', '/v4/shipping-methods', '/v4/posts', '/v4/feeds/main'].includes(path)
    || /^\/v4\/posts\/\d+(?:\/comments|\/merchandises)?$/.test(path)
    || /^\/v4\/merchandises\/\d+$/.test(path)
    || /^\/v4\/channels\/[^/]+(?:\/posts|\/series)?$/.test(path)
    || /^\/v4\/(?:channel-posts|channel-series)\/\d+$/.test(path)
    || /^\/v4\/search\/(?:posts|merchandises-with-post|merchandises-without-post|channel-posts|channels)$/.test(path)) return 'utc-v1';
  return 'legacy-kst';
}

// 사람용 'local' 표시는 실행 환경의 로캘·ICU 데이터에 기대지 않는 고정 형식(YYYY-MM-DD HH:MM KST)만 쓴다.
// 클랙 서비스는 전부 한국 시간 기준이므로 호스트의 시스템 타임존과 무관하게 Asia/Seoul로 고정한다.
// 이전에는 Intl.DateTimeFormat('ko-KR', {dateStyle:'medium', timeStyle:'long'})를 썼는데, 실행 환경(로캘·TTY 여부·ICU
// 빌드)에 따라 오전/오후 표기가 'PM 6시'·'오후 7시'처럼 달라졌다(E9). 24시간제 숫자만 조립해 이 편차를 없앤다.
const KST_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
function formatKst(date: Date): string {
  const parts = Object.fromEntries(KST_PARTS.formatToParts(date).map(part => [part.type, part.value]));
  // 자정을 나타내는 로캘별 '24시' 표기 차이를 없애기 위해 hour12:false에서도 종종 나오는 '24'는 '00'으로 정규화한다.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute} KST`;
}

/** 날짜만 있는 값과 본문은 변환하지 않는다. 명시적으로 분류한 실제 시점 필드에만 사용한다. */
export function formatInstant(value: string, contract: TimeContract, mode: 'local' | 'utc'): string {
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);
  const legacyWallClock = contract === 'legacy-kst' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?$/.test(value);
  if (!iso && !legacyWallClock) return value;
  const source = contract === 'legacy-kst' ? (iso ? value.slice(0, -1) : value.replace(' ', 'T')) + '+09:00' : value;
  const date = new Date(source);
  if (!Number.isFinite(date.getTime())) return value;
  return mode === 'utc' ? date.toISOString() : formatKst(date);
}

const instantKeys = new Set(['created_at', 'updated_at', 'published_at', 'hidden_at', 'owner_hidden_at', 'delete_available_at', 'lastBulkBumpedAt', 'deleted_at', 'expires_at', 'revoked_at', 'suspended_at', 'last_used_at']);
export function displayData(value: unknown, contract: TimeContract, mode: 'local' | 'utc'): unknown {
  if (Array.isArray(value)) return value.map(entry => displayData(entry, contract, mode));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    instantKeys.has(key) && typeof entry === 'string' ? formatInstant(entry, contract, mode) : displayData(entry, contract, mode),
  ]));
  return value;
}
