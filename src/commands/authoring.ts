import { lstat, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Command } from 'commander';
import { z } from 'zod';
import type { ApiClient } from '../core/api.js';
import { CliError } from '../core/errors.js';
import type { Runtime } from '../core/types.js';
import { readPlatformBodyFile } from './platform.js';

const session = { session_id: z.uuid() };
const revision = z.number().int().min(0);
const field = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const itemIndex = z.number().int().min(0).max(23);
const image = { ...session, form_revision: revision, asset_slot: field,
  approved_price_cash: z.number().int().positive(), idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/) };
export const authoringInput = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), skill_slug: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), skill_version: z.string().min(1).max(64), tier: z.enum(['economy', 'performance']).optional() }),
  ...(['get', 'assets', 'quote', 'fill-quote', 'validate'] as const).map((action) => z.strictObject({ action: z.literal(action), ...session })),
  z.strictObject({ action: z.literal('save'), ...session, revision, values: z.record(z.string(), z.unknown()) }),
  z.strictObject({ action: z.literal('import'), ...session, revision, field, content_id: z.uuid() }),
  z.strictObject({ action: z.literal('upload'), ...session, field, file: z.string().min(1).max(4096), item_index: itemIndex.optional() }),
  z.strictObject({ action: z.literal('image'), ...image, item_index: itemIndex.optional() }),
  z.strictObject({ action: z.literal('image-batch'), ...image, item_indexes: z.array(itemIndex).min(1).max(8).refine((values) => new Set(values).size === values.length) }),
  z.strictObject({ action: z.literal('tool'), ...session, call_id: z.uuid() }),
  z.strictObject({ action: z.literal('fill'), ...session, revision, fields: z.array(field).max(60).optional(), instruction: z.string().max(4000).optional(), tier: z.enum(['economy', 'performance']).optional() }),
  z.strictObject({ action: z.literal('fill-status'), ...session, job_id: z.uuid() }),
  z.strictObject({ action: z.literal('package'), ...session, revision }),
  z.strictObject({ action: z.literal('complete'), ...session }),
  z.strictObject({ action: z.literal('abandon'), ...session, confirm: z.boolean().optional() }),
]);

/** 센터와 동일한 제작 API를 CLI와 로컬 MCP에서 공유한다. */
export async function authoringRequest(client: ApiClient, raw: unknown, surface: 'cli' | 'mcp' = 'cli') {
  const result = authoringInput.safeParse(raw);
  if (!result.success) throw new CliError('제작 작업의 입력 형식을 확인하세요.', 'VALIDATION_ERROR');
  const input = result.data;
  const base = '/v4/creator/authoring-sessions';
  if (input.action === 'create') {
    const { action: _action, ...body } = input;
    return client.request('POST', base, { body: { ...body, surface } });
  }
  const path = `${base}/${input.session_id}`;
  if (input.action === 'complete' || input.action === 'abandon') {
    return client.request('POST', `${path}/complete`, { body: { outcome: input.action === 'complete' ? 'completed' : 'abandoned' } });
  }
  if (input.action === 'get') return client.request('GET', path);
  if (input.action === 'assets') return client.request('GET', `${path}/assets`);
  if (input.action === 'quote') return client.request('GET', `${path}/tools/image.generate/quote`);
  if (input.action === 'fill-quote') return client.request('GET', `${path}/fill/quote`);
  if (input.action === 'tool') return client.request('GET', `${path}/tools/${input.call_id}`);
  if (input.action === 'fill-status') return client.request('GET', `${path}/fill/${input.job_id}`);
  if (input.action === 'upload') {
    const stat = await lstat(input.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024 || !stat.size) throw new CliError('이미지는 일반 파일이며 4 MiB 이하여야 합니다.');
    const bytes = await readFile(input.file);
    const body = new FormData();
    body.append('field', input.field);
    if (input.item_index !== undefined) body.append('item_index', String(input.item_index));
    body.append('file', new Blob([bytes]), basename(input.file));
    return client.request('POST', `${path}/assets`, { body });
  }
  if (input.action === 'image' || input.action === 'image-batch') {
    const { action, session_id: _id, idempotency_key, ...body } = input;
    return client.request('POST', `${path}/tools/image.generate${action === 'image-batch' ? '/batch' : ''}`, { body,
      headers: { 'Idempotency-Key': idempotency_key } });
  }
  if (input.action === 'validate') return client.request('POST', `${path}/validate`, { body: {} });
  const { action, session_id: _id, ...body } = input;
  return client.request(action === 'save' ? 'PATCH' : 'POST', `${path}/${action === 'save' ? 'form' : action}`, { body });
}

export function registerAuthoringCommands(program: Command, runtime: Runtime) {
  const command = program.command('authoring').description('스킬 제작·패키징·폼 세션 완료/포기 (creator-content:write)')
    .option('--input <file>', 'action과 요청 값이 있는 JSON 파일')
    .addHelpText('after', '\n폼 세션만 PAT로 완료·포기할 수 있습니다. 에디터·지침형은 센터에서 작업하세요.\ncomplete는 현재 revision을 package한 뒤 사용합니다. 종료 재호출은 AUTHORING_SESSION_LOCKED입니다.');
  const run = async (ctx: Parameters<Parameters<Runtime['action']>[1]>[0], raw: unknown) => {
    const parsed = authoringInput.safeParse(raw);
    if (!parsed.success) throw new CliError('제작 작업 입력 형식을 확인하세요.', 'VALIDATION_ERROR');
    if (ctx.options.dryRun) {
      ctx.output({ dry_run: true, input: parsed.data });
      return;
    }
    if (parsed.data.action === 'abandon') await ctx.confirm(`제작 세션 ${parsed.data.session_id}을 포기합니다. 이후 편집할 수 없습니다. 기존 콘텐츠는 유지됩니다.`);
    ctx.output(await authoringRequest(ctx.api, parsed.data));
  };
  runtime.action(command, async (ctx, _args, opts) => {
    if (!opts.input) throw new CliError('--input <file> 또는 complete/abandon <session-id>를 지정하세요.');
    await run(ctx, await readPlatformBodyFile(opts.input));
  });
  for (const action of ['complete', 'abandon'] as const) {
    runtime.action(command.command(`${action} <session-id>`)
      .description(action === 'complete' ? '현재 패키징된 폼 세션을 완성 상태로 종료' : '폼 세션 포기 (비대화형 실행은 --yes 필요)'), async (ctx, args, opts) => {
      if (opts.input) throw new CliError('하위 명령과 --input을 함께 사용할 수 없습니다.');
      await run(ctx, { action, session_id: args[0] });
    });
  }
}
