import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { imageSize } from 'image-size';
import { z } from 'zod';
import type { CommandContext } from '../core/types.js';
import { CliError, asCliError } from '../core/errors.js';

const policySchema = z.object({
  thumbnail_upload_enabled: z.boolean(),
  thumbnail_upload: z.object({ max_upload_bytes: z.number().int().positive(), max_input_pixels: z.number().int().positive(),
    formats: z.array(z.enum(['image/png', 'image/jpeg', 'image/webp'])).min(1) }),
});
const thumbnailSchema = z.object({ id: z.uuid(), status: z.literal('succeeded'), image_url: z.url() });

/** 일반 이미지 CDN 업로드와 달리 콘텐츠에 연결할 본인 소유 작업 ID를 발급받는다. 서버가 디코딩·소유권을 최종 검사한다. */
export async function prepareContentThumbnail(ctx: CommandContext, source: string) {
  const response = await ctx.api.request('GET', '/v4/creator/config', { auth: false });
  const result = policySchema.safeParse(response.data);
  if (!result.success) throw new CliError('서버 썸네일 업로드 설정이 필요합니다. 서버 업데이트 후 다시 시도하세요.', 'THUMBNAIL_CONFIG_REQUIRED', 409);
  if (!result.data.thumbnail_upload_enabled) throw new CliError('이 환경에서는 썸네일 업로드를 사용할 수 없습니다. content config로 기능 상태를 확인하세요.', 'THUMBNAIL_UPLOAD_DISABLED', 503);
  const policy = result.data.thumbnail_upload;
  const path = resolve(source);
  const info = await stat(path).catch(() => { throw new CliError('썸네일 파일을 찾을 수 없습니다.', 'THUMBNAIL_FILE_NOT_FOUND', 400); });
  if (!info.isFile() || !info.size) throw new CliError('비어 있지 않은 로컬 이미지 파일을 지정하세요.', 'THUMBNAIL_EMPTY_FILE', 400);
  if (info.size > policy.max_upload_bytes) throw new CliError(`썸네일은 ${policy.max_upload_bytes}바이트 이하여야 합니다.`, 'THUMBNAIL_TOO_LARGE', 413);
  const bytes = await readFile(path).catch(() => { throw new CliError('썸네일 파일을 읽을 권한이 필요합니다.', 'THUMBNAIL_FILE_UNREADABLE', 400); });
  if (!bytes.length || bytes.length > policy.max_upload_bytes) throw new CliError('읽는 동안 썸네일 크기가 바뀌었습니다. 파일을 다시 확인하세요.', 'THUMBNAIL_TOO_LARGE', 413);
  let mime: string;
  try {
    const image = imageSize(bytes);
    mime = ({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[image.type ?? ''] ?? '';
    if (!policy.formats.includes(mime as 'image/png') || !image.width || !image.height || image.width * image.height > policy.max_input_pixels) throw new Error();
  } catch { throw new CliError('서버가 지원하는 PNG·JPEG·WebP 이미지와 유효한 크기가 필요합니다. 손상된 파일은 다시 저장하세요.', 'THUMBNAIL_INVALID_IMAGE', 422); }
  return { path, bytes, mime };
}
export async function uploadContentThumbnail(ctx: CommandContext, image: Awaited<ReturnType<typeof prepareContentThumbnail>>) {
  const body = new FormData();
  body.append('file', new Blob([new Uint8Array(image.bytes)], { type: image.mime }), basename(image.path));
  const response = await ctx.api.request('POST', '/v4/creator/thumbnails', { body });
  const parsed = thumbnailSchema.safeParse(response.data);
  if (!parsed.success) throw new CliError('완료된 썸네일 작업 ID를 응답에서 확인할 수 없습니다. 자동 재업로드하지 마세요.', 'INVALID_RESPONSE', 502);
  return { data: parsed.data, time_contract: response.time_contract };
}
/** 업로드 성공 뒤 연결 실패는 ID를 재사용하게 하며 쓰기 요청을 자동 반복하지 않는다. */
export function thumbnailLinkFailure(ctx: CommandContext, cause: unknown, thumbnailId: string, contentId?: string, creation?: Record<string, unknown>): CliError {
  const failure = asCliError(cause);
  // 오류 안내를 복사해 실행해도 원래 API·프로필을 쓰도록 하고, 사용자 제목은 셸에서 실행되지 않게 인용한다.
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const prefix = `clack --base-url ${quote(ctx.api.settings.baseUrl)}${ctx.options.profile ? ` --profile ${quote(ctx.options.profile)}` : ''}`;
  const createArgs = ['title', 'description', 'kind', 'policy_version'].flatMap(key => creation?.[key] === undefined ? []
    : [`--${key.replaceAll('_', '-')} ${quote(String(creation[key]))}`]).join(' ');
  const command = contentId ? `${prefix} content update ${contentId} --thumbnail-id ${thumbnailId}`
    : `${prefix} content create ${createArgs} --thumbnail-id ${thumbnailId}`;
  const verify = contentId ? `${prefix} content status ${contentId}` : `${prefix} content list`;
  return new CliError(`${failure.message}\n썸네일 업로드는 완료됐습니다 (ID: ${thumbnailId}). ${verify}로 저장 여부를 확인한 뒤 ${command}로 연결하세요.`,
    failure.code, failure.status, failure.retryAfter, { thumbnail_id: thumbnailId, ...(contentId ? { content_id: contentId } : {}), verification_command: verify, retry_command: command });
}
