import { Option, type Command } from 'commander';
import { z } from 'zod';
import type { Runtime } from '../core/types.js';
import { CliError } from '../core/errors.js';
import { dryRun, mutate, parse } from '../lib/domain.js';
import { prepareContentFile, putContentFile } from './content.js';

const uuid = (value: unknown): string => parse(z.uuid(), value);
const revision = (value: unknown): number => parse(z.coerce.number().int().nonnegative().max(4294967295), value);
const base = '/v4/creator/custom-pages';
const presentationSchema = z.object({
  schema_version: z.literal(1),
  header_mode: z.enum(['fixed', 'scroll_hide', 'translucent_scroll_hide', 'floating_close', 'floating_close_safe_area']),
  color_scheme: z.enum(['light', 'dark']),
}).strict();

export function registerPageCommands(program: Command, runtime: Runtime): void {
  // 괄호 안 권한 표기는 서버의 PAT 권한 규칙과 같아야 한다. 서버는 submit에만 write·publish 두 권한을 모두 요구한다.
  const page = program.command('page').description('세계관·내 공개 홈 HTML 꾸미기 (custom-page:read·write·publish)');
  runtime.action(page.command('list').description('내 페이지 목록 (custom-page:read)'), async ctx => ctx.output(await ctx.api.request('GET', base)));
  runtime.action(page.command('status <id>').description('페이지와 버전·수정 번호 상태 (custom-page:read)'), async (ctx, [id]) => ctx.output(await ctx.api.request('GET', `${base}/${uuid(id)}`)));
  runtime.action(page.command('create').description('꾸밀 페이지 등록 (custom-page:write)')
    .addOption(new Option('--target <type>', '꾸밀 대상').choices(['profile', 'space']).makeOptionMandatory())
    .option('--space-id <uuid>', '세계관 ID').requiredOption('--policy-version <version>', '동의한 콘텐츠 제공 정책 버전'), async (ctx, _args, opts) => {
    if (opts.target === 'profile' && opts.spaceId) throw new CliError('내 공개 홈에는 세계관 ID를 지정하지 않습니다.');
    const policy = parse(z.literal('2026-09-22'), opts.policyVersion);
    await mutate(ctx, 'POST', base, { target_type: opts.target, ...(opts.target === 'space' ? { space_id: uuid(opts.spaceId) } : {}), policy_version: policy });
  });
  runtime.action(page.command('upload <id> <file>').description('HTML/ZIP 업로드로 새 비공개 버전 생성 (custom-page:write)')
    .addOption(new Option('--header <mode>', '헤더 표시').choices(['fixed', 'scroll_hide', 'translucent_scroll_hide', 'floating_close', 'floating_close_safe_area']).default('fixed'))
    .addOption(new Option('--color <scheme>', '헤더 색상').choices(['light', 'dark']).default('light')), async (ctx, [id, file], opts) => {
    const path = `${base}/${uuid(id)}`;
    const prepared = await prepareContentFile(file!);
    const presentation = parse(presentationSchema, { schema_version: 1, header_mode: opts.header, color_scheme: opts.color });
    const body = { ...prepared.metadata, presentation };
    for (const warning of prepared.warnings) process.stderr.write(`패키지 경고: ${warning}\n`);
    if (dryRun(ctx, 'POST', `${path}/uploads`, body)) return;
    const upload = (await ctx.api.request<{ upload_id: string; upload_url: string; headers: Record<string, string> }>('POST', `${path}/uploads`, { body })).data;
    await putContentFile(upload, prepared.bytes);
    try { ctx.output(await ctx.api.request('POST', `${path}/uploads/${uuid(upload.upload_id)}/complete`, { body: {} })); }
    catch (failure) {
      if (failure instanceof CliError) throw new CliError(`${failure.message} 완료만 재시도하려면: clack page complete ${id} ${upload.upload_id}`, failure.code, failure.status);
      throw failure;
    }
  });
  runtime.action(page.command('complete <id> <upload-id>').description('업로드 완료 처리 재시도 (custom-page:write)'), async (ctx, [id, uploadId]) =>
    mutate(ctx, 'POST', `${base}/${uuid(id)}/uploads/${uuid(uploadId)}/complete`, {}));
  runtime.action(page.command('presentation <id> <version-id>').description('파일은 두고 헤더 설정만 바꾼 새 버전 생성 (custom-page:write)')
    .addOption(new Option('--header <mode>', '새 버전의 헤더 표시').choices(['fixed', 'scroll_hide', 'translucent_scroll_hide', 'floating_close', 'floating_close_safe_area']).makeOptionMandatory())
    .addOption(new Option('--color <scheme>', '새 버전의 헤더 색상').choices(['light', 'dark']).makeOptionMandatory()), async (ctx, [id, versionId], opts) =>
    mutate(ctx, 'POST', `${base}/${uuid(id)}/versions/${uuid(versionId)}/presentation`, {
      presentation: parse(presentationSchema, { schema_version: 1, header_mode: opts.header, color_scheme: opts.color }),
    }));
  runtime.action(page.command('preview <id> <version-id>').description('앱 확인용 미리보기 링크 조회 (custom-page:read)'), async (ctx, [id, versionId]) =>
    ctx.output(await ctx.api.request('GET', `${base}/${uuid(id)}/versions/${uuid(versionId)}/preview`)));
  runtime.action(page.command('submit <id> <version-id>')
    .description('앱에서 확인 완료한 버전의 심사 요청 (custom-page:write와 custom-page:publish 둘 다 필요)'), async (ctx, [id, versionId]) =>
    mutate(ctx, 'POST', `${base}/${uuid(id)}/versions/${uuid(versionId)}/submit`, {}, '앱에서 확인한 이 버전의 심사를 요청할까요? 승인 뒤 직접 적용해야 합니다.'));
  for (const name of ['apply', 'restore']) {
    runtime.action(page.command(`${name} <id> <version-id>`)
      .description(`${name === 'apply' ? '승인된 버전 적용' : '이전 승인 버전으로 복원'} (custom-page:publish)`).requiredOption('--revision <number>', 'status에서 확인한 현재 수정 번호'), async (ctx, [id, versionId], opts) =>
      mutate(ctx, 'POST', `${base}/${uuid(id)}/apply`, { version_id: uuid(versionId), revision: revision(opts.revision) }, '승인된 이 버전의 파일과 헤더 설정을 적용할까요?'));
  }
  runtime.action(page.command('disable <id>').description('기본 화면으로 전환 (custom-page:publish)').requiredOption('--revision <number>', 'status에서 확인한 현재 수정 번호'), async (ctx, [id], opts) =>
    mutate(ctx, 'POST', `${base}/${uuid(id)}/disable`, { revision: revision(opts.revision) }, '기본 화면으로 전환할까요? 업로드한 버전은 보존됩니다.'));
}
