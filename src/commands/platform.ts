import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type { PlatformApiOperations } from '../vendor/clack-types/platform-server.generated.js';
import { z } from 'zod';
import { ApiClient, type ApiOptions } from '../core/api.js';
import { CliError } from '../core/errors.js';
import { rememberSecret } from '../core/secrets.js';
import type { CommandContext, Runtime } from '../core/types.js';

const name = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const viewerId = z.string().regex(/^v_[a-z2-7]{26}$/);
const utcInstant = z.iso.datetime({ offset: false });
const positiveInt = z.coerce.number().int().positive();
const revision = positiveInt.max(Number.MAX_SAFE_INTEGER);
const documentBody = z.record(z.string(), z.unknown());
const documentTarget = z.strictObject({ collection: name, key: z.union([name, z.literal('@me')]), viewer_id: viewerId.optional() });
const maxBodyBytes = 64 * 1024;

export const platformReadSchemas = {
  usage: z.strictObject({ from: utcInstant.optional(), to: utcInstant.optional() }),
  get: z.strictObject({ collection: name, key: z.union([name, z.literal('@me')]), viewer_id: viewerId.optional() }),
  list: z.strictObject({ collection: name, viewer_id: viewerId.optional(), owner: z.enum(['me', 'any']).optional(),
    order: z.enum(['updated_desc', 'sort_desc', 'sort_asc']).optional(), cursor: z.string().min(1).max(512).optional(),
    limit: positiveInt.max(50).optional() }),
  leaderboard: z.strictObject({ collection: name, viewer_id: viewerId.optional(), limit: positiveInt.max(100).optional() }),
  put: documentTarget.extend({ body: documentBody, if_rev: revision.optional(), if_absent: z.boolean().optional(),
    confirm: z.boolean().optional() }),
  patch: documentTarget.extend({ patch: documentBody, if_rev: revision, confirm: z.boolean().optional() }),
  delete: documentTarget.extend({ confirm: z.boolean().optional() }),
};

function value<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new CliError(`${label} 형식을 확인하세요.`, 'VALIDATION_ERROR');
  return parsed.data;
}

export function platformServerClient(settings: ApiOptions, env: NodeJS.ProcessEnv = process.env): ApiClient {
  const key = env.CLACK_SERVER_KEY?.trim() ?? '';
  if (key) rememberSecret(key);
  if (!/^csk_[a-f0-9]{64}$/.test(key)) {
    throw new CliError('CLACK_SERVER_KEY에 플랫폼 서버 키(csk_)를 설정하세요.', 'SERVER_KEY_REQUIRED', 401);
  }
  return new ApiClient({ ...settings, token: key });
}

/** 로컬 플랫폼 MCP의 스킬·콘텐츠 공개·공유 문서 도구는 개인 액세스 토큰(pat_)으로 동작한다.
 * `clack mcp serve-platform`은 저장된 로그인 자격을 읽지 않으므로(§integrations.ts) 환경변수로 명시한다. */
export function platformPatClient(settings: ApiOptions, env: NodeJS.ProcessEnv = process.env): ApiClient {
  const token = env.CLACK_TOKEN?.trim() ?? '';
  if (token) rememberSecret(token);
  if (!/^pat_[a-f0-9]{64}$/.test(token)) {
    throw new CliError('CLACK_TOKEN에 개인 액세스 토큰(pat_)을 설정하세요.', 'PAT_REQUIRED', 401);
  }
  return new ApiClient({ ...settings, token });
}

export async function platformUsage(client: ApiClient, input: unknown) {
  const query: PlatformApiOperations['getServerUsage']['query'] = value(platformReadSchemas.usage, input, '사용량 조회 입력');
  if (query.from && query.to) {
    const interval = Date.parse(query.to) - Date.parse(query.from);
    if (interval <= 0 || interval > 90 * 86_400_000) throw new CliError('조회 기간은 90일 이내여야 합니다.', 'VALIDATION_ERROR');
  }
  return client.request<PlatformApiOperations['getServerUsage']['response']['data']>('GET', '/platform/v1/usage', { query });
}

export async function platformDocument(client: ApiClient, input: unknown) {
  const { collection, key, viewer_id } = value(platformReadSchemas.get, input, '문서 조회 입력');
  const query: PlatformApiOperations['getServerDocument']['query'] = { viewer_id };
  return client.request<PlatformApiOperations['getServerDocument']['response']['data']>(
    'GET', `/platform/v1/data/${collection}/docs/${key}`, { query });
}

export async function platformDocuments(client: ApiClient, input: unknown) {
  const { collection, ...query } = value(platformReadSchemas.list, input, '문서 목록 입력');
  const typedQuery: PlatformApiOperations['listServerDocuments']['query'] = query;
  return client.request<PlatformApiOperations['listServerDocuments']['response']['data']>(
    'GET', `/platform/v1/data/${collection}/docs`, { query: typedQuery });
}

export async function platformLeaderboard(client: ApiClient, input: unknown) {
  const { collection, ...query } = value(platformReadSchemas.leaderboard, input, '순위 조회 입력');
  const typedQuery: PlatformApiOperations['getServerLeaderboard']['query'] = query;
  return client.request<PlatformApiOperations['getServerLeaderboard']['response']['data']>(
    'GET', `/platform/v1/data/${collection}/leaderboard`, { query: typedQuery });
}

function documentPath(collection: string, key: string) {
  return `/platform/v1/data/${collection}/docs/${key}`;
}

function bodySize(body: Record<string, unknown>): number {
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (bytes > maxBodyBytes) throw new CliError('문서 본문은 64 KiB 이하여야 합니다.', 'VALIDATION_ERROR');
  return bytes;
}

export async function readPlatformBodyFile(file: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size === 0 || info.size > maxBodyBytes) throw new Error();
    raw = await readFile(file, 'utf8');
  } catch { throw new CliError('64 KiB 이하의 JSON 파일을 읽을 수 있어야 합니다.', 'VALIDATION_ERROR'); }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new CliError('문서 파일은 올바른 JSON이어야 합니다.', 'VALIDATION_ERROR'); }
  const parsed = value(documentBody, body, '문서 본문');
  bodySize(parsed);
  return parsed;
}

export function platformWritePreview(kind: 'put' | 'patch' | 'delete', input: unknown) {
  if (kind === 'delete') {
    const { collection, key, viewer_id } = value(platformReadSchemas.delete, input, '문서 삭제 입력');
    return { method: 'DELETE', path: documentPath(collection, key), ...(viewer_id ? { viewer_id } : {}) };
  }
  if (kind === 'put') {
    const parsed = value(platformReadSchemas.put, input, '문서 쓰기 입력');
    if ((parsed.if_rev === undefined) === (parsed.if_absent !== true)) {
      throw new CliError('전체 쓰기에는 --if-rev 또는 --if-absent 중 하나가 필요합니다.', 'VALIDATION_ERROR');
    }
    return { method: 'PUT', path: documentPath(parsed.collection, parsed.key),
      ...(parsed.viewer_id ? { viewer_id: parsed.viewer_id } : {}),
      ...(parsed.if_rev ? { if_rev: parsed.if_rev } : { if_absent: true }),
      byte_size: bodySize(parsed.body), sha256: createHash('sha256').update(JSON.stringify(parsed.body)).digest('hex') };
  }
  const parsed = value(platformReadSchemas.patch, input, '문서 수정 입력');
  return { method: 'PATCH', path: documentPath(parsed.collection, parsed.key),
    ...(parsed.viewer_id ? { viewer_id: parsed.viewer_id } : {}),
    if_rev: parsed.if_rev, byte_size: bodySize(parsed.patch),
    sha256: createHash('sha256').update(JSON.stringify(parsed.patch)).digest('hex') };
}

export async function platformPutDocument(client: ApiClient, input: unknown) {
  platformWritePreview('put', input);
  const { collection, key, viewer_id, body, if_rev, if_absent } = value(platformReadSchemas.put, input, '문서 쓰기 입력');
  const query: PlatformApiOperations['putServerDocument']['query'] = { viewer_id };
  const headers: PlatformApiOperations['putServerDocument']['headers'] = if_rev
    ? { 'If-Match': `"${if_rev}"` } : { 'If-None-Match': '*' };
  const requestBody: PlatformApiOperations['putServerDocument']['body'] = { body };
  return client.request<PlatformApiOperations['putServerDocument']['response']['data']>(
    'PUT', documentPath(collection, key), { query, headers, body: requestBody });
}

export async function platformPatchDocument(client: ApiClient, input: unknown) {
  platformWritePreview('patch', input);
  const { collection, key, viewer_id, patch, if_rev } = value(platformReadSchemas.patch, input, '문서 수정 입력');
  const query: PlatformApiOperations['patchServerDocument']['query'] = { viewer_id };
  const headers: PlatformApiOperations['patchServerDocument']['headers'] = { 'If-Match': `"${if_rev}"` };
  const requestBody: PlatformApiOperations['patchServerDocument']['body'] = { patch };
  return client.request<PlatformApiOperations['patchServerDocument']['response']['data']>(
    'PATCH', documentPath(collection, key), { query, headers, body: requestBody });
}

export async function platformDeleteDocument(client: ApiClient, input: unknown) {
  platformWritePreview('delete', input);
  const { collection, key, viewer_id } = value(platformReadSchemas.delete, input, '문서 삭제 입력');
  const query: PlatformApiOperations['deleteServerDocument']['query'] = { viewer_id };
  return client.request<null>('DELETE', documentPath(collection, key), { query });
}

/** 공개 OpenAPI의 서버 키 데이터 계약을 사용한다. 개인 도구 경로는 계약 확정 후 추가한다. */
export function registerPlatformCommands(program: Command, runtime: Runtime): void {
  const platform = program.command('platform').description('플랫폼 서버 키 사용량·데이터 관리');
  runtime.action(platform.command('usage').description('서버 키가 속한 콘텐츠의 사용량 조회')
    .option('--from <utc>', '시작 시각(RFC 3339 UTC)').option('--to <utc>', '종료 시각(RFC 3339 UTC)'), async (ctx, _args, opts) => {
    ctx.output(await platformUsage(platformServerClient(ctx.api.settings), { from: opts.from, to: opts.to }));
  });

  const data = platform.command('data').description('서버 키 데이터 조회·단일 문서 변경');
  runtime.action(data.command('get <collection> <key>').option('--viewer-id <id>', '시청자 범위 문서의 가명 ID'),
    async (ctx, [collection, key], opts) => {
      ctx.output(await platformDocument(platformServerClient(ctx.api.settings),
        { collection, key, viewer_id: opts.viewerId }));
    });
  runtime.action(data.command('list <collection>').option('--viewer-id <id>', '시청자 범위 문서의 가명 ID')
    .option('--owner <scope>', 'me 또는 any').option('--order <order>', 'updated_desc, sort_desc 또는 sort_asc')
    .option('--cursor <cursor>', '다음 페이지 커서').option('--limit <count>', '1~50개'),
  async (ctx, [collection], opts) => {
    ctx.output(await platformDocuments(platformServerClient(ctx.api.settings),
      { collection, viewer_id: opts.viewerId, owner: opts.owner, order: opts.order, cursor: opts.cursor, limit: opts.limit }));
  });
  runtime.action(data.command('leaderboard <collection>').option('--viewer-id <id>', '내 순위를 조회할 가명 ID')
    .option('--limit <count>', '1~100개'), async (ctx, [collection], opts) => {
    ctx.output(await platformLeaderboard(platformServerClient(ctx.api.settings),
      { collection, viewer_id: opts.viewerId, limit: opts.limit }));
  });
  runtime.action(data.command('put <collection> <key>').requiredOption('--file <path>', '문서 본문 JSON 파일')
    .option('--viewer-id <id>', '시청자 범위 문서의 가명 ID')
    .option('--if-rev <rev>', '현재 문서 개정 번호').option('--if-absent', '문서가 없을 때만 생성'),
  async (ctx, [collection, key], opts) => {
    const body = await readPlatformBodyFile(opts.file);
    const input = { collection, key, viewer_id: opts.viewerId, body, if_rev: opts.ifRev, if_absent: opts.ifAbsent };
    const preview = platformWritePreview('put', input);
    if (ctx.options.dryRun) { ctx.output({ dry_run: true, ...preview }); return; }
    await ctx.confirm(`${collection}/${key} 문서 전체를 새 본문으로 저장할까요?`);
    ctx.output(await platformPutDocument(platformServerClient(ctx.api.settings), input));
  });
  runtime.action(data.command('patch <collection> <key>').requiredOption('--file <path>', '병합 패치 JSON 파일')
    .requiredOption('--if-rev <rev>', '현재 문서 개정 번호')
    .option('--viewer-id <id>', '시청자 범위 문서의 가명 ID'),
  async (ctx, [collection, key], opts) => {
    const patch = await readPlatformBodyFile(opts.file);
    const input = { collection, key, viewer_id: opts.viewerId, patch, if_rev: opts.ifRev };
    const preview = platformWritePreview('patch', input);
    if (ctx.options.dryRun) { ctx.output({ dry_run: true, ...preview }); return; }
    await ctx.confirm(`${collection}/${key} 문서를 병합 수정할까요?`);
    ctx.output(await platformPatchDocument(platformServerClient(ctx.api.settings), input));
  });
  runtime.action(data.command('delete <collection> <key>').option('--viewer-id <id>', '시청자 범위 문서의 가명 ID'),
    async (ctx, [collection, key], opts) => {
      const input = { collection, key, viewer_id: opts.viewerId };
      const preview = platformWritePreview('delete', input);
      if (ctx.options.dryRun) { ctx.output({ dry_run: true, ...preview }); return; }
      await ctx.confirm(`${collection}/${key} 문서를 삭제하거나 숨길까요?`);
      ctx.output(await platformDeleteDocument(platformServerClient(ctx.api.settings), input));
    });
}
