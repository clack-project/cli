import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { imageSize } from 'image-size';
import { CliError } from '../core/errors.js';
import type { CommandContext } from '../core/types.js';
import { isCdnImage } from '../schemas/channel.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heif: 'image/heif', avif: 'image/avif', bmp: 'image/bmp', tiff: 'image/tiff', svg: 'image/svg+xml' };
// 검증된 MIME(로컬 파일 내용 기준)에서 확장자를 역으로 찾는다. 로컬 원본 파일명은 서버로 보내지 않는다.
const EXTENSION_BY_MIME: Record<string, string> = Object.fromEntries(Object.entries(MIME).map(([extension, mime]) => [mime, extension]));
export type PreparedImage = { source: string; bytes?: Uint8Array; mime?: string; width?: number; height?: number };
export function isRemoteImage(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try { const url = new URL(value); return !url.username && !url.password; } catch { return false; }
}
function dimensions(bytes: Uint8Array): { width: number; height: number; mime: string } {
  try {
    const result = imageSize(bytes);
    if (!result.width || !result.height || result.width > 20000 || result.height > 20000 || !result.type || !MIME[result.type]) throw new Error();
    return { width: result.width, height: result.height, mime: MIME[result.type] };
  } catch { throw new CliError('지원되는 이미지 파일과 유효한 크기가 필요합니다.'); }
}
export async function prepareImage(source: string, baseDir = process.cwd(), measureRemote = false): Promise<PreparedImage> {
  if (isRemoteImage(source)) {
    if (!measureRemote) return { source };
    if (!isCdnImage(source)) throw new CliError('채널 본문은 클랙 CDN 이미지만 사용할 수 있습니다.');
    const response = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok || !response.body) throw new CliError('CDN 이미지 크기를 읽을 수 없습니다.');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > MAX_IMAGE_BYTES) throw new CliError('이미지는 최대 10MB입니다.'); chunks.push(chunk.value); }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { source, ...dimensions(bytes) };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source)) throw new CliError('이미지는 로컬 파일 또는 http(s) URL이어야 합니다.');
  const path = resolve(baseDir, source);
  let bytes: Uint8Array;
  try { const info = await stat(path); if (!info.isFile() || info.size === 0 || info.size > MAX_IMAGE_BYTES) throw new Error(); bytes = await readFile(path); if (bytes.length > MAX_IMAGE_BYTES) throw new Error(); } catch { throw new CliError(`10MB 이하 이미지 파일을 읽을 수 없습니다: ${path}`); }
  return { source: path, bytes, ...dimensions(bytes) };
}
export async function uploadPrepared(ctx: CommandContext, image: PreparedImage): Promise<{ originalUrl: string; thumbnail400Url?: string }> {
  if (!image.bytes) return { originalUrl: image.source };
  if (ctx.options.dryRun) return { originalUrl: image.source };
  const body = new FormData();
  const extension = image.mime ? EXTENSION_BY_MIME[image.mime] : undefined;
  const filename = `${randomUUID()}${extension ? `.${extension}` : ''}`;
  body.append('file', new Blob([new Uint8Array(image.bytes)], { type: image.mime }), filename);
  const result = await ctx.api.request<{ originalUrl: string; thumbnail400Url: string }>('POST', '/v4/images/upload', { body });
  if (!result.data?.originalUrl) throw new CliError('이미지 업로드 응답에 URL이 없습니다.', 'INVALID_RESPONSE', 502);
  return result.data;
}
export async function prepareImages(images: string[], baseDir?: string): Promise<PreparedImage[]> { return Promise.all(images.map((source) => prepareImage(source, baseDir))); }
export async function uploadImages(ctx: CommandContext, images: PreparedImage[]): Promise<{ images: string[]; thumbnail_400?: string }> {
  const result = []; for (const image of images) result.push(await uploadPrepared(ctx, image));
  return { images: result.map((image) => image.originalUrl), ...(result[0]?.thumbnail400Url ? { thumbnail_400: result[0].thumbnail400Url } : {}) };
}
