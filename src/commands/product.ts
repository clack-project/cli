import { rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Command } from 'commander';
import type { Runtime, CommandContext, ApiResult } from '../core/types.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/secrets.js';
import { productCreateSchema, productUpdateSchema, PRODUCT_TYPES } from '../schemas/product.js';
import { PRODUCT_CATEGORIES } from '../schemas/categories.js';
import { dryRun, fields, id, inputBody, list, mutate, nonempty, paginationOptions, parse, readJson } from '../lib/domain.js';
import { prepareImages, uploadImages } from '../lib/images.js';

const PRODUCT_FIELDS = ['type', 'images', 'name', 'category', 'price', 'description', 'brand', 'size', 'condition', 'delivery_fee', 'safe_trade_fee_payer', 'lang', 'currency', 'republish'];
function productOptions(command: Command): Command {
  return command.option('-f, --file <file>', '상품 JSON 파일').option('--type <type>', 'sell|buy|groupbuy|randombox|commission').option('--images <images...>', '로컬 이미지 또는 URL').option('--name <name>', '상품명').option('--category <category>', '저장용 카테고리').option('--price <price>', '가격').option('--description <text>', '설명').option('--brand <brand>', '브랜드').option('--size <size>', '크기').option('--condition <condition>', '상태').option('--delivery-fee <fee>', '배송비').option('--safe-trade-fee-payer <payer>', 'buyer|seller').option('--currency <currency>', 'KRW|USD');
}
export type BatchReport = { version: 1; command: 'product.create'; results: Array<{ index: number; input: unknown; ok: boolean; id?: number; code?: string; message?: string; dry_run?: boolean; retryable?: boolean }>; summary: { total: number; succeeded: number; failed: number } };

async function saveReport(file: string | undefined, report: BatchReport): Promise<void> {
  if (!file) return;
  report.summary = { total: report.results.length, succeeded: report.results.filter((item) => item.ok).length, failed: report.results.filter((item) => !item.ok).length };
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(redact(report), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

/** 재개 보고서는 항목 원문과 성공 여부를 보존하여 성공 항목을 다시 생성하지 않는다. */
export function resumeReport(value: unknown): BatchReport {
  const raw = value as any; const report = typeof raw?.ok === 'boolean' && raw.data ? raw.data : raw;
  if (report?.version !== 1 || report.command !== 'product.create' || !Array.isArray(report.results) || !report.results.length || report.results.some((item: any) => !item || !Number.isSafeInteger(item.index) || item.index < 0 || typeof item.ok !== 'boolean' || !item.input || typeof item.input !== 'object' || Array.isArray(item.input) || item.dry_run)) throw new CliError('실제 product create 배치 보고서가 필요합니다. dry-run 보고서는 재개할 수 없습니다.');
  if (new Set(report.results.map((item: any) => item.index)).size !== report.results.length) throw new CliError('배치 항목 번호가 중복되었습니다.');
  return report;
}
async function rateLimitedCreate(ctx: CommandContext, body: unknown): Promise<ApiResult<{ id?: number }>> {
  for (let attempt = 0; ; attempt++) {
    try { return await ctx.api.request<{ id?: number }>('POST', '/v4/merchandises', { body }); }
    catch (error) {
      if (!(error instanceof CliError) || error.status !== 429 || attempt >= 3) throw error;
      const retry = (error as CliError & { retryAfter?: number; retry_after?: number }).retryAfter ?? (error as any).retry_after ?? 1;
      await delay(Math.max(retry, 2 ** attempt) * 1000);
    }
  }
}
export function registerProductCommands(program: Command, runtime: Runtime): void {
  const product = program.command('product').description('내 상품 관리');
  runtime.action(product.command('types'), async (ctx) => ctx.output(PRODUCT_TYPES));
  runtime.action(product.command('categories'), async (ctx) => ctx.output(PRODUCT_CATEGORIES));
  runtime.action(product.command('shipping-methods'), async (ctx) => ctx.output(await ctx.api.request('GET', '/v4/shipping-methods')));
  runtime.action(paginationOptions(product.command('list').option('--status <status>', 'selling|trading|sold|hidden')), async (ctx, _args, opts) => {
    if (opts.status && !['selling', 'trading', 'sold', 'hidden'].includes(opts.status)) throw new CliError('상품 상태가 올바르지 않습니다.');
    await list(ctx, '/v4/merchandises/mine', opts, { status: opts.status });
  });
  runtime.action(product.command('get <id>'), async (ctx, [value]) => ctx.output(await ctx.api.request('GET', `/v4/merchandises/${id(value)}`)));
  runtime.action(productOptions(product.command('create')).option('--lang <lang>', '상품 언어').option('--resume <report>', '실패 항목 재개 보고서').option('--report <file>', '항목별 결과 저장'), async (ctx, _args, opts) => {
    if (opts.resume && (opts.file || PRODUCT_FIELDS.some((key) => fields(opts, [key])[key] !== undefined))) throw new CliError('--resume은 파일·상품 필드와 함께 사용할 수 없습니다.');
    let report: BatchReport; let isBatch = !!opts.resume;
    const baseDir = opts.file ? dirname(resolve(opts.file)) : process.cwd();
    if (opts.resume) report = resumeReport(await readJson(opts.resume));
    else {
      const source = opts.file ? await readJson(opts.file) : fields(opts, PRODUCT_FIELDS);
      isBatch = Array.isArray(source);
      const inputs = (isBatch ? source as unknown[] : [source]).map((input) => opts.file && input && typeof input === 'object' && !Array.isArray(input) ? { ...input, ...fields(opts, PRODUCT_FIELDS) } : input);
      if (!inputs.length) throw new CliError('등록할 상품이 없습니다.');
      report = { version: 1, command: 'product.create', results: inputs.map((input, index) => ({ index, input, ok: false })), summary: { total: inputs.length, succeeded: 0, failed: 0 } };
    }
    if (!ctx.options.dryRun) await saveReport(opts.report, report);
    for (const item of report.results) {
      if (item.ok || item.retryable === false) continue;
      let createAttempted = false;
      try {
        const raw = item.input && typeof item.input === 'object' && !Array.isArray(item.input) ? { lang: ctx.api.settings.lang ?? 'ko', ...item.input } : item.input;
        const body = parse(productCreateSchema, raw);
        const images = await prepareImages(body.images, opts.resume ? process.cwd() : baseDir);
        item.input = { ...body, images: images.map((image) => image.source) };
        if (ctx.options.dryRun) { item.ok = true; item.dry_run = true; delete item.code; delete item.message; continue; }
        const uploaded = await uploadImages(ctx, images);
        item.input = { ...body, ...uploaded };
        // 응답 직후 프로세스가 종료되어도 재개가 같은 상품을 다시 생성하지 않도록 먼저 기록한다.
        item.retryable = false; item.code = 'OUTCOME_UNKNOWN'; item.message = '생성 요청 결과 확인 전입니다. 앱에서 생성 여부를 확인하세요.';
        await saveReport(opts.report, report);
        createAttempted = true;
        const result = await rateLimitedCreate(ctx, item.input);
        item.ok = true; item.id = result.data?.id; delete item.code; delete item.message; delete item.retryable;
        if (!isBatch && !opts.report) { ctx.output(result); return; }
      } catch (error) {
        if (!isBatch && !opts.report) throw error;
        item.ok = false; item.code = error instanceof CliError ? error.code : 'REQUEST_FAILED'; item.message = error instanceof Error ? error.message : '요청에 실패했습니다.';
        item.retryable = !createAttempted || (error instanceof CliError && error.status >= 400 && error.status < 500);
        if (!item.retryable) { item.code = 'OUTCOME_UNKNOWN'; item.message = '등록 결과를 확인할 수 없어 자동 재실행하지 않습니다. 앱에서 생성 여부를 확인하세요.'; }
      }
      if (!ctx.options.dryRun) await saveReport(opts.report, report);
    }
    report.summary = { total: report.results.length, succeeded: report.results.filter((item) => item.ok).length, failed: report.results.filter((item) => !item.ok).length };
    await saveReport(opts.report, report);
    if (report.summary.failed) {
      ctx.output({ ok: false, status: 422, code: 'BATCH_FAILED', message: `${report.summary.failed}개 상품을 등록하지 못했습니다. 항목별 결과를 확인하세요.`, data: report, time_contract: 'utc-v1' });
      process.exitCode = 6;
    } else ctx.output(report);
  });
  runtime.action(productOptions(product.command('update <id>')).option('--republish', '게시 시각 갱신'), async (ctx, [value], opts) => {
    const path = `/v4/merchandises/${id(value)}`;
    let body = parse(productUpdateSchema, await inputBody(opts, PRODUCT_FIELDS)); nonempty(body);
    const images = body.images ? await prepareImages(body.images, opts.file ? dirname(resolve(opts.file)) : undefined) : undefined;
    if (dryRun(ctx, 'PATCH', path, body)) return;
    if (images) body = { ...body, ...await uploadImages(ctx, images) };
    await mutate(ctx, 'PATCH', path, body);
  });
  runtime.action(product.command('status <id> <status>'), async (ctx, [value, status]) => {
    const statuses: Record<string, string | null> = { selling: null, trading: '거래중', sold: '거래완료' };
    if (!Object.hasOwn(statuses, status)) throw new CliError('selling, trading, sold 중 하나를 입력하세요.');
    await mutate(ctx, 'PATCH', `/v4/merchandises/${id(value)}/status`, { order_status: statuses[status] }, status === 'sold' ? '상품을 거래완료로 변경할까요?' : undefined);
  });
  runtime.action(product.command('bump [ids...]').option('--all', '끌어올릴 수 있는 내 상품 모두'), async (ctx, args, opts) => {
    const ids = args.flat().filter(Boolean).map(id);
    if ((opts.all && ids.length) || (!opts.all && !ids.length)) throw new CliError('상품 ID 또는 --all 중 하나를 지정하세요.');
    if (opts.all) { await mutate(ctx, 'POST', '/v4/my/bulk-bump/execute'); return; }
    const results = [];
    for (const value of ids) {
      const path = `/v4/merchandises/${value}/bump`;
      if (ctx.options.dryRun) results.push({ id: value, dry_run: true, method: 'PATCH', path });
      else results.push({ id: value, ...await ctx.api.request('PATCH', path) });
    }
    ctx.output({ data: results, time_contract: 'legacy-kst' });
  });
  for (const action of ['hide', 'unhide', 'delete']) runtime.action(product.command(`${action} <id>`), async (ctx, [value]) => {
    await mutate(ctx, action === 'delete' ? 'DELETE' : 'PATCH', `/v4/merchandises/${id(value)}${action === 'delete' ? '' : `/${action}`}`, undefined, action === 'delete' ? '상품을 삭제할까요?' : undefined);
  });
}
