import { z } from 'zod';
export const postFieldsSchema = z.object({
  type: z.string().trim().min(1), subject: z.string().trim().min(1).optional(),
  content: z.string().trim().min(1), images: z.array(z.string().min(1)).max(12).optional(),
  lang: z.string().regex(/^[a-z]{2}$/).optional(),
}).strict();
export function postCreateSchema(boardType: string) {
  return postFieldsSchema.superRefine((data, ctx) => {
    if (boardType === 'image' && !data.images?.length) ctx.addIssue({ code: 'custom', path: ['images'], message: '이미지 게시판에는 이미지가 필요합니다.' });
    if (boardType !== 'image' && !data.subject) ctx.addIssue({ code: 'custom', path: ['subject'], message: '게시판 제목이 필요합니다.' });
  });
}
export const postUpdateSchema = postFieldsSchema.partial();
export const commentCreateSchema = z.object({ content: z.string().trim().min(1), parent_id: z.number().int().positive().optional(), lang: z.string().regex(/^[a-z]{2}$/).optional() }).strict();
