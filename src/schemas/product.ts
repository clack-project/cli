import { z } from 'zod';
import { PRODUCT_CATEGORIES } from './categories.js';

export const PRODUCT_TYPES = ['sell', 'buy', 'groupbuy', 'randombox', 'commission'] as const;
const money = z.union([z.number(), z.string().regex(/^\d+(?:\.\d{1,2})?$/, '금액 형식을 확인하세요.')]).transform(Number).pipe(z.number().finite().nonnegative()).refine((value) => /^\d+(?:\.\d{1,2})?$/.test(String(value)), '금액은 소수점 둘째 자리까지 입력하세요.');
const fields = z.object({
  type: z.enum(PRODUCT_TYPES),
  images: z.array(z.string().trim().min(1)).min(1).max(12),
  name: z.string().trim().min(1).max(99),
  category: z.string().refine((value) => PRODUCT_CATEGORIES.includes(value) || ['랜덤박스', '공동 구매', '커미션'].includes(value), 'product categories에서 저장용 카테고리를 확인하세요.'),
  price: money,
  description: z.string().trim().min(1),
  brand: z.string().optional(), size: z.string().nullable().optional(), condition: z.string().optional(),
  delivery_fee: money.nullable().optional(), safe_trade_fee_payer: z.enum(['buyer', 'seller']).optional(),
  shipping_options: z.array(z.object({ method_code: z.string().trim().min(1), fee: money, is_default: z.boolean().optional() }).strict()).optional(),
  lang: z.string().regex(/^[a-z]{2}$/).optional(), currency: z.enum(['KRW', 'USD']).optional(),
  thumbnail_400: z.string().optional(), extra_data: z.string().nullable().optional(),
}).strict();

function validateCurrency(data: { lang?: string; currency?: string; price?: number; delivery_fee?: number | null; shipping_options?: { fee: number }[] }, ctx: z.RefinementCtx, create: boolean) {
  const currency = data.currency ?? (create || data.lang ? (data.lang === 'en' ? 'USD' : 'KRW') : undefined);
  if (create && data.currency && data.currency !== (data.lang === 'en' ? 'USD' : 'KRW')) {
    ctx.addIssue({ code: 'custom', path: ['currency'], message: 'lang=en은 USD, 그 외 언어는 KRW를 사용합니다.' });
  }
  if (currency === 'KRW') {
    for (const [key, value] of [['price', data.price], ['delivery_fee', data.delivery_fee]] as const) {
      if (value != null && !Number.isInteger(value)) ctx.addIssue({ code: 'custom', path: [key], message: 'KRW 금액은 정수여야 합니다.' });
    }
    data.shipping_options?.forEach((option, i) => {
      if (!Number.isInteger(option.fee)) ctx.addIssue({ code: 'custom', path: ['shipping_options', i, 'fee'], message: 'KRW 금액은 정수여야 합니다.' });
    });
  }
}
export const productCreateSchema = fields.superRefine((data, ctx) => validateCurrency(data, ctx, true)).transform((data) => ({ ...data, lang: data.lang ?? 'ko', currency: data.lang === 'en' ? 'USD' as const : 'KRW' as const }));
export const productUpdateSchema = fields.omit({ lang: true }).partial().extend({ republish: z.boolean().optional() }).strict().superRefine((data, ctx) => validateCurrency(data, ctx, false));
