import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import type { PostBlock, PostImageBlock } from '../vendor/clack-types/models/channel.js';
import type { Runtime, CommandContext } from '../core/types.js';
import { CliError } from '../core/errors.js';
import { channelPostCreateSchema, channelPostUpdateSchema, channelUpdateSchema, channelCreateSchema, seriesCreateSchema, seriesUpdateSchema } from '../schemas/channel.js';
import { csv, dryRun, id, inputBody, list, mutate, nonempty, onOff, paginationOptions, parse } from '../lib/domain.js';
import { prepareImage, uploadPrepared, type PreparedImage } from '../lib/images.js';
import { markdownToBlocks } from '../lib/markdown-to-blocks.js';

async function ownChannel(ctx: CommandContext): Promise<{ id: number; slug: string }> {
  const result = await ctx.api.request<{ id: number; slug: string } | null>('GET', '/v4/me/channel');
  if (!result.data) throw new CliError('앱에서 먼저 채널을 개설하세요.', 'CHANNEL_NOT_FOUND', 404);
  return result.data;
}
function imageOptions(command: Command): Command { return command.option('-f, --file <file>', 'JSON 파일').option('--description <text>', '설명').option('--cover-image <image>', '커버 이미지'); }
async function prepareImageFields(body: Record<string, unknown>, keys: string[], baseDir: string): Promise<Map<string, PreparedImage>> {
  const images = new Map<string, PreparedImage>();
  for (const key of keys) if (typeof body[key] === 'string' && body[key]) images.set(key, await prepareImage(body[key] as string, baseDir));
  return images;
}
async function uploadImageFields(ctx: CommandContext, body: Record<string, unknown>, images: Map<string, PreparedImage>): Promise<void> { for (const [key, image] of images) body[key] = (await uploadPrepared(ctx, image)).originalUrl; }
export function registerChannelCommands(program: Command, runtime: Runtime): void {
  const channel = program.command('channel').description('내 크리에이터 채널 관리');
  runtime.action(channel.command('get'), async (ctx) => ctx.output(await ctx.api.request('GET', '/v4/me/channel')));
  runtime.action(imageOptions(channel.command('create')).option('--name <name>', '채널 이름').option('--slug <slug>', '채널 슬러그').option('--avatar-image <image>', '프로필 이미지'), async (ctx, _args, opts) => {
    const body = parse(channelCreateSchema, await inputBody(opts, ['name', 'slug', 'description', 'cover_image', 'avatar_image']));
    const images = await prepareImageFields(body, ['cover_image', 'avatar_image'], opts.file ? dirname(resolve(opts.file)) : process.cwd());
    if (dryRun(ctx, 'POST', '/v4/channels', body)) return;
    await uploadImageFields(ctx, body, images); await mutate(ctx, 'POST', '/v4/channels', body);
  });
  runtime.action(imageOptions(channel.command('update')).option('--name <name>', '채널 이름').option('--avatar-image <image>', '프로필 이미지').option('--id <id>', '채널 ID (생략 시 내 채널)'), async (ctx, _args, opts) => {
    const body = parse(channelUpdateSchema, await inputBody(opts, ['name', 'description', 'cover_image', 'avatar_image'])); nonempty(body);
    const images = await prepareImageFields(body, ['cover_image', 'avatar_image'], opts.file ? dirname(resolve(opts.file)) : process.cwd());
    const path = `/v4/channels/${opts.id ? id(opts.id) : (await ownChannel(ctx)).id}`;
    if (dryRun(ctx, 'PATCH', path, body)) return;
    await uploadImageFields(ctx, body, images); await mutate(ctx, 'PATCH', path, body);
  });
  const post = channel.command('post').description('채널 포스트 관리');
  runtime.action(paginationOptions(post.command('list').option('--status <status>', 'draft|published|hidden')), async (ctx, _args, opts) => {
    if (opts.status && !['draft', 'published', 'hidden'].includes(opts.status)) throw new CliError('채널 포스트 상태를 확인하세요.');
    await list(ctx, '/v4/me/channel-posts', opts, { status: opts.status });
  });
  runtime.action(post.command('get <id>'), async (ctx, [value]) => ctx.output(await ctx.api.request('GET', `/v4/channel-posts/${id(value)}`)));
  for (const action of ['create', 'update'] as const) runtime.action(post.command(action === 'create' ? action : 'update <id>').option('-f, --file <file>', '채널 포스트 JSON').option('--from-markdown <file>', '마크다운 원고').option('--title <text>', '제목 (생략 시 마크다운 파일명)').option('--status <status>', 'draft|published').option('--channel-id <id>', '채널 ID').option('--series <id>', '시리즈 ID').option('--tags <tags>', '태그 (쉼표 구분)').option('--thumbnail <image>', '썸네일 이미지'), async (ctx, args, opts) => {
    let body = await inputBody(opts, ['title', 'status', 'thumbnail']);
    if (opts.channelId !== undefined) body.channel_id = id(opts.channelId);
    if (opts.series !== undefined) body.series_id = id(opts.series);
    if (opts.tags !== undefined) body.tags = csv(opts.tags);
    const baseDir = opts.fromMarkdown ? dirname(resolve(opts.fromMarkdown)) : opts.file ? dirname(resolve(opts.file)) : process.cwd();
    const pending: Array<{ url: string; image: PreparedImage }> = [];
    async function imageBlock(source: string, alt: string): Promise<Omit<PostImageBlock, 'type'>> {
      const image = await prepareImage(source, baseDir, true);
      const url = image.bytes ? `https://storage.clack.kr/__clack_cli_pending__/${pending.length}` : image.source;
      pending.push({ url, image });
      return { url, width: image.width!, height: image.height!, ...(alt ? { alt } : {}) };
    }
    if (opts.fromMarkdown) {
      if (body.content !== undefined) throw new CliError('JSON content와 --from-markdown 중 하나를 지정하세요.');
      const result = await markdownToBlocks(await readFile(opts.fromMarkdown, 'utf8'), { resolveImage: imageBlock });
      body.content = result.blocks;
      if (!body.title && action === 'create') body.title = basename(opts.fromMarkdown).replace(/\.[^.]+$/, '');
      for (const warning of result.warnings) process.stderr.write(`${warning}\n`);
    } else if (Array.isArray(body.content)) {
      const blocks: unknown[] = [];
      for (const block of body.content) {
        if (block?.type === 'image' && typeof block.url === 'string') blocks.push({ type: 'image', ...await imageBlock(block.url, block.alt ?? '') });
        else blocks.push(block);
      }
      body.content = blocks;
    }
    if (action === 'create') { body.status ??= 'draft'; body.channel_id ??= (await ownChannel(ctx)).id; body = parse(channelPostCreateSchema, body); }
    else { body = parse(channelPostUpdateSchema, body); nonempty(body); }
    const imageFields = await prepareImageFields(body, ['thumbnail'], baseDir);
    const path = action === 'create' ? '/v4/channel-posts' : `/v4/channel-posts/${id(args[0])}`;
    if (ctx.options.dryRun) { ctx.output({ dry_run: true, method: action === 'create' ? 'POST' : 'PATCH', path, body, uploads: pending.filter((item) => item.image.bytes).map((item) => item.image.source) }); return; }
    const blocks = body.content as PostBlock[] | undefined;
    for (const item of pending) {
      const uploaded = await uploadPrepared(ctx, item.image);
      const block = blocks?.find((block): block is PostImageBlock => block.type === 'image' && block.url === item.url);
      if (block) block.url = uploaded.originalUrl;
    }
    await uploadImageFields(ctx, body, imageFields);
    body = parse(action === 'create' ? channelPostCreateSchema : channelPostUpdateSchema, body);
    await mutate(ctx, action === 'create' ? 'POST' : 'PATCH', path, body);
  });
  runtime.action(post.command('delete <id>'), async (ctx, [value]) => mutate(ctx, 'DELETE', `/v4/channel-posts/${id(value)}`, undefined, '채널 포스트를 삭제할까요?'));
  const series = channel.command('series').description('채널 시리즈 관리');
  runtime.action(series.command('list').option('--handle <handle>', '채널 슬러그 (생략 시 내 채널)').option('--page <page>', '페이지', '1').option('--per-page <number>', '페이지 크기', '20'), async (ctx, _args, opts) => {
    const handle = opts.handle ?? (await ownChannel(ctx)).slug;
    if (!/^[A-Za-z0-9_-]+$/.test(handle)) throw new CliError('채널 슬러그를 확인하세요.');
    const page = id(opts.page), per_page = id(opts.perPage); if (per_page > 50) throw new CliError('페이지 크기는 최대 50입니다.');
    ctx.output(await ctx.api.request('GET', `/v4/channels/${handle}/series`, { query: { page, per_page } }));
  });
  runtime.action(series.command('get <id>'), async (ctx, [value]) => ctx.output(await ctx.api.request('GET', `/v4/channel-series/${id(value)}`)));
  for (const action of ['create', 'update'] as const) {
    const command = imageOptions(series.command(action === 'create' ? action : 'update <id>')).option('--title <title>', '시리즈 제목');
    if (action === 'create') command.option('--channel-id <id>', '채널 ID');
    else command.option('--is-completed <on|off>', '완결 여부', onOff);
    runtime.action(command, async (ctx, args, opts) => {
      let body = await inputBody(opts, ['title', 'description', 'cover_image', 'is_completed']);
      if (opts.channelId !== undefined) body.channel_id = id(opts.channelId);
      if (action === 'create') { body.channel_id ??= (await ownChannel(ctx)).id; body = parse(seriesCreateSchema, body); }
      else { body = parse(seriesUpdateSchema, body); nonempty(body); }
      const images = await prepareImageFields(body, ['cover_image'], opts.file ? dirname(resolve(opts.file)) : process.cwd());
      const path = action === 'create' ? '/v4/channel-series' : `/v4/channel-series/${id(args[0])}`;
      if (dryRun(ctx, action === 'create' ? 'POST' : 'PATCH', path, body)) return;
      await uploadImageFields(ctx, body, images); await mutate(ctx, action === 'create' ? 'POST' : 'PATCH', path, body);
    });
  }
  runtime.action(series.command('delete <id>'), async (ctx, [value]) => mutate(ctx, 'DELETE', `/v4/channel-series/${id(value)}`, undefined, '시리즈를 삭제할까요?'));
}
