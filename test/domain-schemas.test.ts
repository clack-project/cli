import test from 'node:test';
import assert from 'node:assert/strict';
import { productCreateSchema, productUpdateSchema } from '../src/schemas/product.js';
import { postCreateSchema } from '../src/schemas/post.js';
import { profileSchema } from '../src/schemas/me.js';
import { channelBlocksSchema } from '../src/schemas/channel.js';
import { inlineMarkdown, markdownToBlocks } from '../src/lib/markdown-to-blocks.js';
import { resumeReport } from '../src/commands/product.js';

const product = { type: 'sell', images: ['image.png'], name: '상품', category: '아크릴 > 아크릴 스탠드', price: 1000, description: '설명' };
test('상품 앱 필수값·이미지 상한·이름 길이·거래 유형을 검증한다', () => {
  assert.equal(productCreateSchema.parse(product).currency, 'KRW');
  for (const key of ['type', 'images', 'name', 'category', 'price', 'description']) { const input = { ...product } as Record<string, unknown>; delete input[key]; assert.equal(productCreateSchema.safeParse(input).success, false, key); }
  for (const change of [{ type: 'other' }, { images: Array(13).fill('image.png') }, { name: 'a'.repeat(100) }, { category: '아무거나' }, { price: -1 }]) assert.equal(productCreateSchema.safeParse({ ...product, ...change }).success, false);
});
test('통화·금액 단위·수정 시 언어 계약을 검증한다', () => {
  assert.equal(productCreateSchema.parse({ ...product, lang: 'en', price: '1.23' }).currency, 'USD');
  assert.equal(productCreateSchema.safeParse({ ...product, price: 1.23 }).success, false);
  assert.equal(productCreateSchema.safeParse({ ...product, lang: 'en', price: 1.234 }).success, false);
  assert.equal(productCreateSchema.safeParse({ ...product, lang: 'ko', currency: 'USD' }).success, false);
  assert.equal(productUpdateSchema.safeParse({ lang: 'en' }).success, false);
  assert.equal(productUpdateSchema.safeParse({ price: 1.23, currency: 'USD' }).success, true);
});
test('게시판 유형별 제목·이미지 필수값을 검증한다', () => {
  assert.equal(postCreateSchema('image').safeParse({ type: 'challenge', content: '내용', images: ['a.png'] }).success, true);
  assert.equal(postCreateSchema('image').safeParse({ type: 'challenge', content: '내용' }).success, false);
  assert.equal(postCreateSchema('normal').safeParse({ type: 'talk', content: '내용' }).success, false);
  assert.equal(postCreateSchema('normal').safeParse({ type: 'talk', subject: '제목', content: '내용' }).success, true);
  assert.equal(profileSchema.safeParse({ bank: '금지' }).success, false);
});
test('인라인 marks가 마크다운 제거 뒤 실제 문자 범위를 가리킨다', () => {
  const block = inlineMarkdown('안녕 **굵게** *기울임* [링크](https://clack.kr)');
  assert.equal(block.text, '안녕 굵게 기울임 링크');
  assert.deepEqual(block.marks?.map((mark) => [mark.style, block.text.slice(...mark.range)]), [['bold', '굵게'], ['italic', '기울임'], ['link', '링크']]);
});
test('마크다운 변환은 블록·이미지 크기·강등 경고를 반환한다', async () => {
  const sources: string[] = [];
  const result = await markdownToBlocks('# 제목\n\n본문 **굵게**\n\n---\n\n![대체](photo.png)\n\n- 목록\n\n```ts\nconst a = 1;\n```', { resolveImage: async (source, alt) => { sources.push(source); return { url: 'https://storage.clack.kr/image.png', width: 10, height: 20, alt }; } });
  assert.deepEqual(sources, ['photo.png']); assert.equal(result.blocks.length, 6); assert.equal(result.warnings.length, 2); assert.equal(result.blocks[3].type, 'image');
});
test('CDN 완전 일치·서식 범위·블록 상한을 검증한다', async () => {
  assert.equal(channelBlocksSchema.safeParse([{ type: 'image', url: 'https://evil.test/storage.clack.kr/a.png', width: 1, height: 1 }]).success, false);
  assert.equal(channelBlocksSchema.safeParse([{ type: 'paragraph', text: 'a', marks: [{ range: [0, 2], style: 'bold' }] }]).success, false);
  await assert.rejects(markdownToBlocks(Array(501).fill('문단').join('\n\n'), { resolveImage: async () => { throw new Error('불필요'); } }), /500/);
});
test('재개 보고서는 실제 실패 기록만 수용한다', () => {
  const report = { version: 1, command: 'product.create', results: [{ index: 0, input: product, ok: false }], summary: { total: 1, succeeded: 0, failed: 1 } };
  assert.equal(resumeReport({ ok: true, data: report }), report);
  assert.equal(resumeReport({ ok: false, code: 'BATCH_FAILED', data: report }), report);
  assert.throws(() => resumeReport({ ...report, results: [{ ...report.results[0], dry_run: true }] }));
  assert.throws(() => resumeReport({ ...report, results: [report.results[0], report.results[0]] }));
});
