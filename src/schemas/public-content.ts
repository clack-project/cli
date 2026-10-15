import { z } from 'zod';

/** 공개 카탈로그 조회와 명시적 재사용 동의를 분리한다. CLI·MCP가 공유하는 입력 계약이다. */
export const publicReusePurposeSchema = z.enum(['content', 'template']).default('content');
export const publicContentSearchSchema = z.object({ q: z.string().max(100).optional(), cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(20), reusable: z.enum(['true', 'false']).default('false'),
  purpose: publicReusePurposeSchema, lang: z.enum(['ko', 'en']).optional() }).strict();
export const publicContentIdSchema = z.uuid();
export const publicContentInspectSchema = z.object({ content_id: publicContentIdSchema, purpose: publicReusePurposeSchema }).strict();
export const publicAssetDownloadSchema = z.object({ version_id: z.uuid(), grant_revision: z.coerce.number().int().nonnegative(), purpose: publicReusePurposeSchema }).strict();
export const publicReuseGrantSchema = z.object({ version_id: z.uuid(), expected_revision: z.number().int().nonnegative(), terms_version: z.string().max(32),
  scope: z.enum(['none', 'content', 'template']), agree: z.boolean(), fields: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).max(128),
  asset_ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(24) }).strict();

export const publicCharacterDraftImportSchema = z.object({ request_id: z.uuid(), revision: z.number().int().nonnegative(), source_content_id: z.uuid(), source_version_id: z.uuid(), grant_revision: z.number().int().nonnegative(),
  fields: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(20),
  images: z.object({ portrait: z.string().regex(/^[a-f0-9]{64}$/).optional(), cover: z.string().regex(/^[a-f0-9]{64}$/).optional(), gallery: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(6).optional() }).strict().default({}) }).strict();
