import { z } from 'zod';

// 앱·서버의 POST_BLOCK_LIMITS와 동일하다. 공개 번들은 비공개 패키지 런타임에 의존하지 않는다.
export const POST_BLOCK_LIMITS = { MAX_BLOCKS: 500, MAX_PARAGRAPH_LENGTH: 20000, MAX_TITLE_LENGTH: 200, MAX_TAGS: 10, MAX_TAG_LENGTH: 50 } as const;
export const IMAGE_HOSTS = ['storage.clack.kr', 'storage.dev.clack.kr'];
export function isCdnImage(value: string): boolean {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && IMAGE_HOSTS.includes(url.host.toLowerCase()) && !url.username && !url.password; } catch { return false; }
}
const href = z.string().max(2048).refine((value) => { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } }, '링크는 http(s) 주소여야 합니다.');
const mark = z.object({ range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]), style: z.enum(['bold', 'italic', 'link']), href: href.optional() }).superRefine((data, ctx) => {
  if (data.range[0] >= data.range[1]) ctx.addIssue({ code: 'custom', message: '서식 범위가 올바르지 않습니다.' });
  if (data.style === 'link' && !data.href) ctx.addIssue({ code: 'custom', message: '링크 주소가 필요합니다.' });
});
const paragraph = z.object({ type: z.literal('paragraph'), text: z.string().max(POST_BLOCK_LIMITS.MAX_PARAGRAPH_LENGTH), marks: z.array(mark).max(200).optional() }).superRefine((data, ctx) => {
  if (data.marks?.some((item) => item.range[1] > data.text.length)) ctx.addIssue({ code: 'custom', message: '서식 범위가 본문을 벗어났습니다.' });
});
export const channelBlocksSchema = z.array(z.discriminatedUnion('type', [paragraph, z.object({ type: z.literal('image'), url: z.string().max(2048).refine(isCdnImage, '클랙 CDN 이미지 주소만 사용할 수 있습니다.'), width: z.number().int().positive().max(20000), height: z.number().int().positive().max(20000), alt: z.string().max(500).optional() }), z.object({ type: z.literal('divider') })])).min(1).max(POST_BLOCK_LIMITS.MAX_BLOCKS);
const channelPostFields = z.object({
  title: z.string().trim().min(1).max(200), content: channelBlocksSchema, status: z.enum(['draft', 'published']),
  thumbnail: z.string().min(1).max(512).nullable().optional(), series_id: z.number().int().positive().nullable().optional(), series_order: z.number().int().positive().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(10).optional(),
}).strict();
export const channelPostCreateSchema = channelPostFields.extend({ channel_id: z.number().int().positive() });
export const channelPostUpdateSchema = channelPostFields.partial();
export const channelUpdateSchema = z.object({ name: z.string().trim().min(1).max(45).optional(), description: z.string().max(500).nullable().optional(), avatar_image: z.string().max(512).nullable().optional(), cover_image: z.string().max(512).nullable().optional() }).strict();
export const seriesCreateSchema = z.object({ channel_id: z.number().int().positive(), title: z.string().trim().min(1).max(100), description: z.string().max(500).nullable().optional(), cover_image: z.string().max(512).nullable().optional() }).strict();
export const seriesUpdateSchema = seriesCreateSchema.omit({ channel_id: true }).partial().extend({ is_completed: z.boolean().optional() });

export const channelCreateSchema = channelUpdateSchema.extend({ name: z.string().trim().min(1).max(45), slug: z.string().regex(/^[a-z0-9-]{3,30}$/) });
