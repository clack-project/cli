import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { Option, type Command } from 'commander';
import { z } from 'zod';
import type { Runtime } from '../core/types.js';
import { CliError } from '../core/errors.js';
import { rememberSecret } from '../core/secrets.js';
import { dryRun, mutate, parse } from '../lib/domain.js';
import { inspectContentPackage } from '../lib/content-package.js';

const MAX_BYTES = 30 * 1024 * 1024;
const uuid = (value: unknown): string => parse(z.uuid(), value);
const createSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(''),
  kind: z.enum(['html', 'gallery', 'slideshow', 'video']).default('html'),
  policy_version: z.literal('2026-09-22'),
}).strict();

export async function prepareContentFile(source: string) {
  const file = resolve(source);
  const extension = extname(file).toLowerCase();
  if (!['.html', '.htm', '.zip'].includes(extension)) throw new CliError('HTML 또는 ZIP 파일을 지정하세요.');
  let bytes: Buffer;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size === 0 || info.size > MAX_BYTES) throw new Error();
    bytes = await readFile(file);
    if (!bytes.length || bytes.length > MAX_BYTES) throw new Error();
  } catch { throw new CliError('30 MiB 이하의 비어 있지 않은 파일을 읽을 수 있어야 합니다.'); }
  return { bytes, warnings: extension === '.zip' ? inspectContentPackage(bytes) : [],
    metadata: { filename: basename(file), content_type: extension === '.zip' ? 'application/zip' : 'text/html',
      byte_size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
}

interface UploadSession { upload_id: string; upload_url: string; headers: Record<string, string>; }

/** API 토큰을 전송하지 않고 전용 비공개 S3에만 선택한 파일을 전송한다. */
export async function putContentFile(session: UploadSession, bytes: Buffer, fetcher: typeof fetch = fetch): Promise<void> {
  uuid(session.upload_id);
  let url: URL;
  try {
    url = new URL(session.upload_url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || !/^clack-creator-content-(dev|prod)-\d{12}-[a-z0-9-]+\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)
      || !url.pathname.startsWith('/_staging/')) throw new Error();
  } catch { throw new CliError('콘텐츠 전용 업로드 주소를 확인할 수 없습니다.', 'INVALID_UPLOAD_RESPONSE', 502); }
  const contentType = session.headers?.['Content-Type'];
  const checksum = session.headers?.['x-amz-checksum-sha256'];
  if (!['text/html', 'application/zip'].includes(contentType ?? '')
    || checksum !== createHash('sha256').update(bytes).digest('base64')) {
    throw new CliError('업로드 체크섬과 파일 형식이 일치하지 않습니다.', 'INVALID_UPLOAD_RESPONSE', 502);
  }
  rememberSecret(session.upload_url);
  try {
    const result = await fetcher(url, { method: 'PUT', headers: { 'Content-Type': contentType, 'x-amz-checksum-sha256': checksum },
      body: new Uint8Array(bytes), redirect: 'error', signal: AbortSignal.timeout(120_000) });
    if (!result.ok) throw new Error();
  } catch { throw new CliError('파일 업로드에 실패했습니다. 새 업로드를 시작하세요.', 'CONTENT_UPLOAD_FAILED', 0); }
}

/** 서버 키 발급·회전은 PAT보다 오래 사는 비밀값을 새로 만들므로 크리에이터 센터 세션 전용이다. CLI는 요청 없이 안내만 한다. */
const SERVER_KEY_CENTER_ONLY = '서버 키 발급·회전은 크리에이터 센터(내 콘텐츠 → 서버 키)에서만 할 수 있습니다. CLI·MCP의 개인 액세스 토큰으로는 서버 키 조회·폐기만 할 수 있습니다.';
const collection = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, '이름은 영숫자·밑줄·붙임표 64자 이하여야 합니다.');
const documentKey = collection;
const keyId = (value: unknown) => { const id = String(value); if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new CliError('서버 키 ID는 양의 정수여야 합니다.'); return id; };

export function registerContentCommands(program: Command, runtime: Runtime): void {
  const content = program.command('content').description('HTML 콘텐츠 등록·앱 확인·심사 관리');
  runtime.action(content.command('config'), async (ctx) => ctx.output(await ctx.api.request('GET', '/v4/creator/config', { auth: false })));
  runtime.action(content.command('list'), async (ctx) => ctx.output(await ctx.api.request('GET', '/v4/creator/contents')));
  runtime.action(content.command('status <id>'), async (ctx, [id]) => ctx.output(await ctx.api.request('GET', `/v4/creator/contents/${uuid(id)}`)));
  runtime.action(content.command('create').requiredOption('--title <text>', '제목').option('--description <text>', '설명', '')
    .option('--kind <kind>', 'html|gallery|slideshow|video', 'html').requiredOption('--policy-version <version>', '동의한 콘텐츠 제공 정책 버전'), async (ctx, _args, opts) => {
    const body = parse(createSchema, { title: opts.title, description: opts.description, kind: opts.kind, policy_version: opts.policyVersion });
    await mutate(ctx, 'POST', '/v4/creator/contents', body);
  });
  runtime.action(content.command('upload <id> <file>')
    .addOption(new Option('--header <mode>', '헤더 표시').choices(['fixed', 'scroll_hide', 'translucent_scroll_hide', 'floating_close']))
    .addOption(new Option('--color <scheme>', '헤더 색상').choices(['light', 'dark'])), async (ctx, [id, file], opts) => {
    const path = `/v4/creator/contents/${uuid(id)}`;
    const prepared = await prepareContentFile(file!);
    for (const warning of prepared.warnings) process.stderr.write(`패키지 경고: ${warning}\n`);
    const metadata = { ...prepared.metadata, ...(opts.header || opts.color ? { presentation: { schema_version: 1, header_mode: opts.header ?? 'fixed', color_scheme: opts.color ?? 'light' } } : {}) };
    if (dryRun(ctx, 'POST', `${path}/uploads`, metadata)) return;
    const session = (await ctx.api.request<UploadSession>('POST', `${path}/uploads`, { body: metadata })).data;
    await putContentFile(session, prepared.bytes);
    try { ctx.output(await ctx.api.request('POST', `${path}/uploads/${uuid(session.upload_id)}/complete`)); }
    catch (error) {
      if (error instanceof CliError) throw new CliError(`${error.message} 완료만 재시도하려면: clack content complete ${id} ${session.upload_id}`, error.code, error.status);
      throw error;
    }
  });
  runtime.action(content.command('complete <id> <upload-id>'), async (ctx, [id, uploadId]) =>
    mutate(ctx, 'POST', `/v4/creator/contents/${uuid(id)}/uploads/${uuid(uploadId)}/complete`));
  runtime.action(content.command('preview <id> <version-id>'), async (ctx, [id, versionId]) =>
    ctx.output(await ctx.api.request('GET', `/v4/creator/contents/${uuid(id)}/versions/${uuid(versionId)}/preview`)));
  runtime.action(content.command('submit <id> <version-id>'), async (ctx, [id, versionId]) =>
    mutate(ctx, 'POST', `/v4/creator/contents/${uuid(id)}/versions/${uuid(versionId)}/submit`, { publish_on_approval: true }, '이 버전을 심사하고 통과하면 공개할까요?'));
  runtime.action(content.command('withdraw <id> <version-id>'), async (ctx, [id, versionId]) =>
    mutate(ctx, 'POST', `/v4/creator/contents/${uuid(id)}/versions/${uuid(versionId)}/review/cancel`, undefined, '이 버전의 심사를 취소할까요?'));
  // 승인은 됐지만 아직 공개하지 않은 버전을 나중에 공개한다. creator-content:publish 권한이 필요하다.
  runtime.action(content.command('publish <id> <version-id>'), async (ctx, [id, versionId]) =>
    mutate(ctx, 'POST', `/v4/creator/contents/${uuid(id)}/versions/${uuid(versionId)}/publish`, undefined, '승인된 이 버전을 공개할까요?'));
  runtime.action(content.command('unpublish <id>'), async (ctx, [id]) =>
    mutate(ctx, 'POST', `/v4/creator/contents/${uuid(id)}/unpublish`, undefined, '콘텐츠 게시를 중단할까요?'));

  // 서버 키(csk_)는 PAT로 조회·폐기만 한다. 발급·회전은 크리에이터 센터 세션 전용이라 CLI는 안내만 하고 요청을 보내지 않는다.
  const serverKeys = content.command('server-keys').description('콘텐츠 서버 키 조회·폐기 (platform:read·platform:write, 발급·회전은 크리에이터 센터)');
  runtime.action(serverKeys.command('list <id>'), async (ctx, [id]) =>
    ctx.output(await ctx.api.request('GET', `/v4/creator/contents/${uuid(id)}/server-keys`)));
  for (const name of ['issue', 'rotate']) {
    runtime.action(serverKeys.command(name).description('크리에이터 센터 전용 안내').argument('[args...]').allowUnknownOption(), async () => {
      throw new CliError(SERVER_KEY_CENTER_ONLY, 'SERVER_KEY_CENTER_ONLY', 403);
    });
  }
  runtime.action(serverKeys.command('revoke <id> <key-id>'), async (ctx, [id, keyIdValue]) =>
    mutate(ctx, 'DELETE', `/v4/creator/contents/${uuid(id)}/server-keys/${keyId(keyIdValue)}`, undefined, '이 서버 키를 즉시 폐기할까요?'));

  // 공유(shared) 문서는 이용자가 쓴 콘텐츠 데이터다. 콘텐츠 소유자는 모더레이션 목적으로 숨기거나 삭제할 수 있다.
  const shared = content.command('shared').description('공유 문서 조회·숨김·삭제 (platform:read·platform:write)');
  runtime.action(shared.command('collections <id>'), async (ctx, [id]) =>
    ctx.output(await ctx.api.request('GET', `/v4/creator/contents/${uuid(id)}/shared-document-collections`)));
  runtime.action(shared.command('list <id> <collection>').option('--limit <count>', '1~100개, 기본 50'), async (ctx, [id, collectionValue], opts) =>
    ctx.output(await ctx.api.request('GET', `/v4/creator/contents/${uuid(id)}/shared-documents/${parse(collection, collectionValue)}`,
      { query: { limit: opts.limit } })));
  runtime.action(shared.command('get <id> <collection> <key>'), async (ctx, [id, collectionValue, keyValue]) =>
    ctx.output(await ctx.api.request('GET',
      `/v4/creator/contents/${uuid(id)}/shared-documents/${parse(collection, collectionValue)}/${parse(documentKey, keyValue)}`)));
  runtime.action(shared.command('hide <id> <collection> <key>'), async (ctx, [id, collectionValue, keyValue]) =>
    mutate(ctx, 'POST',
      `/v4/creator/contents/${uuid(id)}/shared-documents/${parse(collection, collectionValue)}/${parse(documentKey, keyValue)}/hide`,
      undefined, '이 공유 문서를 숨길까요? 목록·순위에서 제외되며 문서 자체는 남습니다.'));
  runtime.action(shared.command('delete <id> <collection> <key>'), async (ctx, [id, collectionValue, keyValue]) =>
    mutate(ctx, 'DELETE',
      `/v4/creator/contents/${uuid(id)}/shared-documents/${parse(collection, collectionValue)}/${parse(documentKey, keyValue)}`,
      undefined, '이 공유 문서를 영구 삭제할까요?'));
}
