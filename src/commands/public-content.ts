import { randomUUID } from 'node:crypto';
import { Option, type Command } from 'commander';
import type { Runtime } from '../core/types.js';
import { csv, mutate, parse } from '../lib/domain.js';
import { downloadPublicContent } from '../lib/public-content-download.js';
import { publicContentIdSchema, publicContentSearchSchema, publicReusePurposeSchema, publicCharacterDraftImportSchema } from '../schemas/public-content.js';

/** 기존 content list/status의 본인 콘텐츠 의미를 유지하면서 공개 조회와 선택 다운로드를 추가한다. */
export function registerPublicContentCommands(content: Command, runtime: Runtime): void {
  const purpose = () => new Option('--purpose <purpose>', 'content: 콘텐츠 제작, template: 템플릿 기본값 재배포').choices(['content', 'template']).default('content');
  runtime.action(content.command('search').description('공개 콘텐츠 검색 (creator-content:read)').option('--query <text>', '제목·설명 검색')
    .option('--cursor <cursor>', '이전 응답 커서').option('--limit <count>', '목록 개수(최대 20)', '20').option('--reusable', '명시적으로 재사용을 허용한 결과만 조회')
    .addOption(purpose()), async (ctx, _args, opts) => {
      const query = parse(publicContentSearchSchema, { q: opts.query, cursor: opts.cursor, limit: opts.limit, reusable: String(!!opts.reusable), purpose: opts.purpose });
      ctx.output(await ctx.api.request('GET', '/v4/creator/public-contents', { query }));
    });
  runtime.action(content.command('inspect <id>').description('공개 정보·고정 버전·재사용 허가 확인 (creator-content:read)').addOption(purpose()), async (ctx, [id], opts) => {
    ctx.output(await ctx.api.request('GET', `/v4/creator/public-contents/${parse(publicContentIdSchema, id)}`, { query: { purpose: parse(publicReusePurposeSchema, opts.purpose) } }));
  });
  runtime.action(content.command('assets <id>').description('허가된 공개 필드·이미지 명세 확인 (creator-content:read)').addOption(purpose()), async (ctx, [id], opts) => {
    ctx.output(await ctx.api.request('GET', `/v4/creator/public-contents/${parse(publicContentIdSchema, id)}/assets`, { query: { purpose: parse(publicReusePurposeSchema, opts.purpose) } }));
  });
  runtime.action(content.command('download <id>').description('선택한 공개 이미지를 출처와 함께 저장 (creator-content:read)')
    .requiredOption('--asset <ids...>', 'assets 응답에서 선택한 이미지 식별자').requiredOption('--out <directory>', '저장할 폴더')
    .addOption(purpose()), async (ctx, [id], opts) => {
      ctx.output(await downloadPublicContent(ctx.api, { contentId: parse(publicContentIdSchema, id), assetIds: opts.asset, output: opts.out,
        purpose: parse(publicReusePurposeSchema, opts.purpose), dryRun: ctx.options.dryRun === true }));
    });
  runtime.action(content.command('draft-create').description('캐릭터챗 편집 초안 생성 (creator-content:write)').option('--template <slug>', '처음 선택할 템플릿')
    .option('--template-version <version>', '고정 템플릿 버전').option('--request-id <uuid>', '재시도할 요청 ID'), async (ctx, _args, opts) => {
      const requestId = parse(publicContentIdSchema, opts.requestId ?? randomUUID());
      await mutate(ctx, 'POST', '/v4/creator/content-drafts', { request_id: requestId, ...(opts.template ? { preset: { skill_slug: opts.template, ...(opts.templateVersion ? { skill_version: opts.templateVersion } : {}) } } : {}) });
    });
  runtime.action(content.command('draft-import <draft-id>').description('허가된 공개 캐릭터 항목을 편집 초안에 복사 (creator-content:read·write)')
    .requiredOption('--source <id>', '공개 원본 콘텐츠 ID').requiredOption('--source-version <id>', '확인한 원본 버전 ID').requiredOption('--grant-revision <number>', '확인한 허가 revision')
    .option('--fields <keys>', '공통 필드 이름을 쉼표로 구분').option('--portrait <asset-id>', '초상 이미지 ID').option('--cover <asset-id>', '표지 이미지 ID')
    .option('--gallery <asset-ids...>', '갤러리 이미지 ID').option('--request-id <uuid>', '재시도할 요청 ID'), async (ctx, [draftId], opts) => {
      const id = parse(publicContentIdSchema, draftId);
      const draft = await ctx.api.request<{ revision: number }>('GET', `/v4/creator/content-drafts/${id}`);
      const body = parse(publicCharacterDraftImportSchema, { request_id: opts.requestId ?? randomUUID(), revision: draft.data.revision,
        source_content_id: opts.source, source_version_id: opts.sourceVersion, grant_revision: Number(opts.grantRevision), fields: opts.fields ? csv(opts.fields) : [],
        images: { ...(opts.portrait ? { portrait: opts.portrait } : {}), ...(opts.cover ? { cover: opts.cover } : {}), ...(opts.gallery ? { gallery: opts.gallery } : {}) } });
      await mutate(ctx, 'POST', `/v4/creator/content-drafts/${id}/public-import`, body);
    });

}
