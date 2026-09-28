import { z } from 'zod';
export const profileSchema = z.object({ name: z.string().trim().min(1).max(16).optional(), instagram: z.string().optional(), twitter: z.string().optional(), birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), avatar: z.string().min(1).optional(), allow_notification: z.boolean().optional() }).strict();
export const addressSchema = z.object({ name: z.string().trim().min(1), contact: z.string().trim().min(1), zipcode: z.string().trim().min(1), address: z.string().trim().min(1), address_detail: z.string().trim().min(1), label: z.string().max(50).nullable().optional(), is_default: z.boolean().optional() }).strict();
export const emailSchema = z.email();
export const langsSchema = z.array(z.string().regex(/^[a-z]{2}$/)).min(1).max(10);
