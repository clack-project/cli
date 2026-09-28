import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import type { Runtime } from '../core/types.js';
import { CliError } from '../core/errors.js';
import { commentCreateSchema, postCreateSchema, postUpdateSchema } from '../schemas/post.js';
import { csv, dryRun, id, inputBody, list, mutate, nonempty, paginationOptions, parse } from '../lib/domain.js';
import { prepareImages, uploadImages } from '../lib/images.js';

const POST_FIELDS = ['type', 'subject', 'content', 'images', 'lang'];
function options(command: Command): Command { return command.option('-f, --file <file>', '게시글 JSON 파일').option('--board <id>', '게시판 board_id').option('--feed', '피드에 작성').option('--subject <text>', '제목').option('--content <text>', '본문').option('--content-file <file>', '본문 텍스트 파일').option('--images <images...>', '로컬 이미지 또는 URL').option('--lang <lang>', '본문 언어'); }
export function registerPostCommands(program: Command, runtime: Runtime): void {
  const post = program.command('post').description('게시글 관리');
  runtime.action(post.command('boards'), async (ctx) => ctx.output(await ctx.api.request('GET', '/v4/boards')));
  runtime.action(paginationOptions(post.command('list')), async (ctx, _args, opts) => list(ctx, '/v4/me/posts', opts));
  runtime.action(post.command('get <id>'), async (ctx, [value]) => ctx.output(await ctx.api.request('GET', `/v4/posts/${id(value)}`)));
  for (const action of ['create', 'update'] as const) runtime.action(options(post.command(action === 'create' ? action : 'update <id>')), async (ctx, args, opts) => {
    if (opts.board && opts.feed) throw new CliError('--board와 --feed는 함께 사용할 수 없습니다.');
    if (opts.content !== undefined && opts.contentFile) throw new CliError('--content와 --content-file 중 하나를 지정하세요.');
    let body = await inputBody(opts, POST_FIELDS);
    if (opts.board || opts.feed) body.type = opts.feed ? 'challenge' : opts.board;
    if (opts.contentFile) body.content = await readFile(opts.contentFile, 'utf8');
    const path = action === 'create' ? '/v4/posts' : `/v4/posts/${id(args[0])}`;
    if (action === 'update') { body = parse(postUpdateSchema, body); nonempty(body); }
    let boardId = body.type;
    if (action === 'update' && !boardId) boardId = (await ctx.api.request<{ type: string }>('GET', path)).data.type;
    const boards = await ctx.api.request<Array<{ board_id: string; board_type: string; can_write?: boolean }>>('GET', '/v4/boards');
    const board = boards.data.find((item) => item.board_id === boardId);
    if (!board) throw new CliError('유효한 게시판 board_id가 필요합니다. post boards로 확인하세요.');
    if (board.can_write === false) throw new CliError('해당 게시판에 작성할 권한이 없습니다.', 'FORBIDDEN', 403);
    if (action === 'create') body = parse(postCreateSchema(board.board_type), body);
    else if (board.board_type === 'image' && Array.isArray(body.images) && !body.images.length) throw new CliError('이미지 게시판의 images는 비울 수 없습니다.');
    const images = body.images ? await prepareImages(body.images as string[], opts.file ? dirname(resolve(opts.file)) : undefined) : undefined;
    if (dryRun(ctx, action === 'create' ? 'POST' : 'PATCH', path, body)) return;
    if (images) body.images = (await uploadImages(ctx, images)).images;
    await mutate(ctx, action === 'create' ? 'POST' : 'PATCH', path, body);
  });
  runtime.action(post.command('delete <id>'), async (ctx, [value]) => mutate(ctx, 'DELETE', `/v4/posts/${id(value)}`, undefined, '게시글과 연결된 댓글을 삭제할까요?'));
  runtime.action(post.command('link-products <id>').requiredOption('--ids <ids...>', '연결할 상품 ID (쉼표 가능)'), async (ctx, [value], opts) => {
    const ids = (opts.ids as string[]).flatMap(csv).map(id);
    await mutate(ctx, 'PATCH', `/v4/posts/${id(value)}/merchandises`, { merchandise_ids: ids });
  });
  const comment = program.command('comment').description('게시글 댓글 관리');
  runtime.action(paginationOptions(comment.command('list <postId>')), async (ctx, [value], opts) => list(ctx, `/v4/posts/${id(value)}/comments`, opts));
  runtime.action(comment.command('add <postId>').requiredOption('--content <text>', '댓글 내용').option('--parent <id>', '부모 댓글 ID').option('--lang <lang>', '언어'), async (ctx, [value], opts) => {
    const body = parse(commentCreateSchema, { content: opts.content, ...(opts.parent ? { parent_id: id(opts.parent) } : {}), ...(opts.lang ? { lang: opts.lang } : {}) });
    await mutate(ctx, 'POST', `/v4/posts/${id(value)}/comments`, body);
  });
  runtime.action(comment.command('delete <postId> <commentId>'), async (ctx, [postId, commentId]) => mutate(ctx, 'DELETE', `/v4/posts/${id(postId)}/comments/${id(commentId)}`, undefined, '댓글을 삭제할까요?'));
}
