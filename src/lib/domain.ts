import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type { z } from 'zod';
import { CliError } from '../core/errors.js';
import type { CommandContext, ApiResult } from '../core/types.js';

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new CliError(result.error.issues.map((issue) => `${issue.path.join('.') || '입력'}: ${issue.message}`).join('; '));
  return result.data;
}
export function id(value: unknown): number {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new CliError('ID는 양의 정수여야 합니다.');
  return Number(value);
}
export function onOff(value: string): boolean {
  if (!['on', 'off', 'true', 'false'].includes(value)) throw new CliError('on 또는 off를 입력하세요.');
  return value === 'on' || value === 'true';
}
export function csv(value: string): string[] { return value.split(',').map((item) => item.trim()).filter(Boolean); }
export function fields(opts: Record<string, unknown>, names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.flatMap((name) => { const key = name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()); return opts[key] === undefined ? [] : [[name, opts[key]]]; }));
}
export function nonempty(body: Record<string, unknown>): void { if (!Object.keys(body).length) throw new CliError('변경할 필드를 하나 이상 지정하세요.'); }
export async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { throw new CliError(`JSON 파일을 읽을 수 없습니다: ${file}`); }
}
export async function inputBody(opts: Record<string, any>, names: string[]): Promise<Record<string, unknown>> {
  const body = opts.file ? await readJson(opts.file) : {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CliError('단일 JSON 객체가 필요합니다.');
  return { ...body, ...fields(opts, names) };
}
export function dryRun(ctx: CommandContext, method: string, path: string, body?: unknown): boolean {
  if (!ctx.options.dryRun) return false;
  ctx.output({ dry_run: true, method, path, ...(body === undefined ? {} : { body }) });
  return true;
}
export async function mutate(ctx: CommandContext, method: string, path: string, body?: unknown, confirmation?: string): Promise<void> {
  if (dryRun(ctx, method, path, body)) return;
  if (confirmation) await ctx.confirm(confirmation);
  ctx.output(await ctx.api.request(method, path, { body }));
}
export function paginationOptions(command: Command): Command { return command.option('--cursor <id>', '다음 페이지 커서').option('--limit <number>', '페이지 크기 (최대 50)', '50').option('--all', '모든 페이지 조회'); }
export function pageQuery(opts: Record<string, any>): { cursor?: string; limit: number } {
  const limit = Number(opts.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new CliError('limit은 1~50이어야 합니다.');
  if (opts.cursor !== undefined) id(opts.cursor);
  return { cursor: opts.cursor, limit };
}
export async function list(ctx: CommandContext, path: string, opts: Record<string, any>, extra: Record<string, string | number | boolean | undefined> = {}): Promise<void> {
  const query = { ...pageQuery(opts), ...extra };
  const firstCursor = query.cursor;
  let forcedContract: 'legacy-kst' | undefined;
  let firstContract: string | undefined;
  const data: unknown[] = [];
  const seen = new Set<string>();
  let result: ApiResult<unknown[]>;
  do {
    result = await ctx.api.request<unknown[]>('GET', path, { query, contract: forcedContract });
    if (!opts.all) { ctx.output(result); return; }
    if (!Array.isArray(result.data)) throw new CliError('목록 응답 형식이 올바르지 않습니다.', 'INVALID_RESPONSE', 502);
    if (firstContract && firstContract !== result.time_contract) {
      forcedContract = 'legacy-kst'; firstContract = undefined; query.cursor = firstCursor; data.length = 0; seen.clear(); continue;
    }
    firstContract = result.time_contract;
    if (result.time_contract === 'legacy-kst') forcedContract = 'legacy-kst';
    data.push(...result.data);
    if (!result.pagination?.has_more) break;
    const cursor = String(result.pagination.next_cursor ?? '');
    if (!cursor || seen.has(cursor)) throw new CliError('페이지 커서가 반복되거나 누락되었습니다.', 'INVALID_RESPONSE', 502);
    seen.add(cursor); query.cursor = cursor;
  } while (true);
  ctx.output({ ...result, data });
}
