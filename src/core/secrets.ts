const secrets = new Set<string>();
const sensitiveKey = /^(?:token|access_token|refresh_token|device_code|password|current_password|new_password|password_confirmation|authorization|cookie|token_hash)$/i;
export function rememberSecret(value: string): void { if (value) secrets.add(value); }
/** 오류 메시지가 입력을 되비추어도 JSON 본문의 인증 정보와 비밀번호를 가린다. */
export function rememberSensitiveValues(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (sensitiveKey.test(key) && typeof entry === 'string') rememberSecret(entry);
    else rememberSensitiveValues(entry);
  }
}
export function redactText(text: string): string {
  let result = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) result = result.split(secret).join('[가림]');
  return result.replace(/\b(?:pat_|dvc_|csk_)[A-Za-z0-9_-]{16,}/g, '[가림]')
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [가림]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    redactText(key), sensitiveKey.test(key) ? '[가림]' : redact(entry),
  ]));
  return value;
}
