export class CliError extends Error {
  constructor(message: string, public code = 'VALIDATION_ERROR', public status = 400, public retryAfter?: number) {
    super(message);
    this.name = 'CliError';
  }
  get exitCode(): number {
    if (this.code === 'USER_API_UNAVAILABLE') return 8;
    if (this.status === 401) return 3;
    if (this.status === 403 || this.status === 423) return 4;
    if (this.status === 404) return 5;
    if ([400, 409, 410, 422].includes(this.status)) return 6;
    if (this.status === 429) return 7;
    if (this.status === 503 && this.code.endsWith('DISABLED')) return 8;
    return 1;
  }
}

/** 서버 오류의 `details`(reason·file·issues·expected·actual)를 사람이 읽을 위치 안내로 바꾼다. 없는 필드는 건너뛴다. */
export function describeDetails(details: unknown): string[] {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return [];
  const d = details as Record<string, unknown>;
  const text = (v: unknown): string | undefined => typeof v === 'string' && v ? v.replace(/[\p{C}]/gu, '').slice(0, 160)
    : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;
  const lines: string[] = [];
  const reason = text(d.reason);
  if (reason) lines.push(`사유: ${reason}`);
  const file = text(d.file);
  if (file) lines.push(`파일: ${file}`);
  if (Array.isArray(d.issues)) {
    for (const issue of d.issues.slice(0, 5)) {
      if (!issue || typeof issue !== 'object') continue;
      const i = issue as Record<string, unknown>;
      const parts = [['파일', i.file], ['위치', i.pointer], ['규칙', i.rule], ['값', i.param]]
        .flatMap(([label, v]) => { const t = text(v); return t ? [`${label}=${t}`] : []; });
      if (parts.length) lines.push(`문제: ${parts.join(' ')}`);
    }
  }
  const expected = text(d.expected);
  const actual = text(d.actual);
  if (expected !== undefined || actual !== undefined) lines.push(`기대: ${expected ?? '-'} / 실제: ${actual ?? '-'}`);
  return lines;
}

export function apiError(status: number, body: unknown, retryAfter: string | null): CliError {
  const value = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const code = typeof value.code === 'string' ? value.code : `HTTP_${status}`;
  let message = typeof value.message === 'string' ? value.message : `요청에 실패했습니다 (${status}).`;
  if (status === 401 && code === 'SERVER_KEY_INVALID') message += ' 센터에서 서버 키 상태를 확인하거나 새로 발급·회전하세요.';
  else if (status === 401) message += ' clack login으로 다시 연결하세요.';
  if (code === 'SESSION_REQUIRED') message += ' 에디터·지침형 스킬은 크리에이터 센터에서 작업하세요. 폼 세션만 PAT로 만들고 끝낼 수 있습니다.';
  if (code === 'AUTHORING_NOT_PACKAGED') message += ' JSON action:package를 clack authoring --input <파일>로 실행한 뒤 authoring complete <세션-ID>를 실행하세요.';
  if (code === 'AUTHORING_SESSION_LOCKED') message += ' JSON action:get을 clack authoring --input <파일>로 실행해 상태를 확인하세요. 이미 종료된 세션은 다시 편집하거나 종료할 수 없습니다.';
  if (code === 'IDENTITY_VERIFICATION_REQUIRED') message += ' 앱에서 본인인증을 완료하세요.';
  if (code === 'SCOPE_DENIED') message += ' 필요한 권한으로 토큰을 다시 발급하세요.';
  if (code === 'SKILL_VERSION_MAJOR_REQUIRED') {
    message += ' clack.skill.json·SKILL.md의 version을 올려 다시 push하세요. 같은 버전을 호환되게 고쳐 올리려면 먼저 clack skill cancel로 이 버전을 지우세요.';
  }
  if (code === 'CONTENT_INFO_VERSION_DISABLED') message += ' clack content config의 info_version.enabled가 true인 환경에서만 사용할 수 있습니다.';
  if (code === 'CONTENT_INFO_UNCHANGED') message += ' 정보를 먼저 clack content update로 수정한 뒤 다시 시도하세요.';
  if (code === 'CONTENT_METADATA_EXTRAS_DISABLED') message += ' 이 환경에서는 언어별 메타데이터·태그를 아직 쓸 수 없습니다.';
  if (status === 423 || code === 'USER_BANNED') message += ' 계정 제한 상태를 앱에서 확인하세요.';
  if (status === 503 && code.endsWith('DISABLED')) message += ' 현재 외부 도구 접근이 일시 중단되었습니다.';
  const located = describeDetails(value.details);
  if (located.length) message += `\n${located.map((line) => `  ${line}`).join('\n')}`;
  const raw = Number(value.retry_after ?? retryAfter);
  const retry = Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : undefined;
  return new CliError(message, code, status, retry);
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof Error && error.name === 'ZodError') {
    const issues = (error as unknown as { issues: { path: unknown[]; message: string }[] }).issues;
    return new CliError(issues.map(i => `${i.path.join('.') || '입력'}: ${i.message}`).join('; '));
  }
  return new CliError(error instanceof Error ? error.message : '요청을 처리하지 못했습니다.', 'INTERNAL_ERROR', 0);
}
