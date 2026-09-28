import { password } from '@inquirer/prompts';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { Command } from 'commander';
import type { Runtime } from '../core/types.js';
import { rememberSecret } from '../core/secrets.js';
import { CliError } from '../core/errors.js';
import { addressSchema, emailSchema, langsSchema, profileSchema } from '../schemas/me.js';
import { csv, dryRun, id, inputBody, mutate, nonempty, onOff, parse } from '../lib/domain.js';
import { isCdnImage } from '../schemas/channel.js';
import { prepareImage, uploadPrepared } from '../lib/images.js';

const ADDRESS_FIELDS = ['name', 'contact', 'zipcode', 'address', 'address_detail', 'label', 'is_default'];
export function registerMeCommands(program: Command, runtime: Runtime): void {
  const me = program.command('me').description('내 개인정보 관리');
  runtime.action(me.command('get'), async (ctx) => ctx.output(await ctx.api.request('GET', '/v4/me')));
  runtime.action(me.command('update').option('-f, --file <file>', '프로필 JSON').option('--name <name>', '이름').option('--instagram <id>', '인스타그램').option('--twitter <id>', '트위터').option('--birth <date>', '생일 YYYY-MM-DD').option('--avatar <image>', '프로필 이미지 경로 또는 URL').option('--allow-notification <on|off>', '알림 허용', onOff), async (ctx, _args, opts) => {
    const body = parse(profileSchema, await inputBody(opts, ['name', 'instagram', 'twitter', 'birth', 'avatar', 'allow_notification'])); nonempty(body);
    const avatar = body.avatar ? await prepareImage(body.avatar, opts.file ? dirname(resolve(opts.file)) : undefined) : undefined;
    if (avatar && !avatar.bytes && (!isCdnImage(avatar.source) || !avatar.source.startsWith('https://'))) throw new CliError('프로필 이미지는 클랙 CDN HTTPS 주소여야 합니다.');
    if (dryRun(ctx, 'PATCH', '/v4/me', body)) return;
    if (avatar) body.avatar = (await uploadPrepared(ctx, avatar)).originalUrl;
    await mutate(ctx, 'PATCH', '/v4/me', body);
  });
  runtime.action(me.command('seller-intro').command('set <text>'), async (ctx, [text]) => mutate(ctx, 'PATCH', '/v4/me/seller-intro', { seller_intro: text }));
  runtime.action(me.command('password').command('change'), async (ctx) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new CliError('비밀번호 변경은 대화형 터미널에서만 가능합니다.', 'TTY_REQUIRED', 400);
    const current_password = await password({ message: '현재 비밀번호', mask: '*' });
    const new_password = await password({ message: '새 비밀번호', mask: '*' });
    const password_confirmation = await password({ message: '새 비밀번호 확인', mask: '*' });
    for (const value of [current_password, new_password, password_confirmation]) rememberSecret(value);
    if (!current_password || !new_password || new_password !== password_confirmation) throw new CliError('비밀번호를 입력하고 새 비밀번호 확인을 일치시키세요.');
    if (ctx.options.dryRun) { ctx.output({ dry_run: true, method: 'PATCH', path: '/v4/me/password', message: '비밀번호 입력 검증 완료' }); return; }
    await mutate(ctx, 'PATCH', '/v4/me/password', { current_password, new_password, password_confirmation });
  });
  runtime.action(me.command('notifications').command('set').option('--marketing <on|off>', '마케팅 수신', onOff).option('--langs <langs>', '선호 언어 (ko,en)').option('--allow-notification <on|off>', '알림 수신', onOff), async (ctx, _args, opts) => {
    const operations: Array<{ path: string; method: string; body: unknown }> = [];
    if (opts.marketing !== undefined) operations.push({ path: '/v4/me/marketing-push-consent', method: 'PATCH', body: { consent: opts.marketing } });
    if (opts.langs !== undefined) operations.push({ path: '/v4/me/langs', method: 'PUT', body: { langs: parse(langsSchema, csv(opts.langs)) } });
    if (opts.allowNotification !== undefined) operations.push({ path: '/v4/me', method: 'PATCH', body: { allow_notification: opts.allowNotification } });
    if (!operations.length) throw new CliError('변경할 알림 설정을 지정하세요.');
    if (ctx.options.dryRun) { ctx.output({ dry_run: true, operations }); return; }
    const results = []; for (const operation of operations) results.push({ path: operation.path, ...await ctx.api.request(operation.method, operation.path, { body: operation.body }) });
    ctx.output({ data: results, time_contract: 'legacy-kst' });
  });
  const address = me.command('address').description('배송지 관리');
  runtime.action(address.command('list'), async (ctx) => ctx.output(await ctx.api.request('GET', '/v4/me/addresses')));
  for (const action of ['add', 'update'] as const) runtime.action(address.command(action === 'add' ? action : 'update <id>').option('-f, --file <file>', '배송지 JSON').option('--name <name>', '수령인').option('--contact <contact>', '연락처').option('--zipcode <zipcode>', '우편번호').option('--address <address>', '주소').option('--address-detail <text>', '상세주소').option('--label <label>', '이름').option('--is-default <on|off>', '기본 배송지', onOff), async (ctx, args, opts) => {
    const body = parse(action === 'add' ? addressSchema : addressSchema.partial(), await inputBody(opts, ADDRESS_FIELDS)); nonempty(body);
    await mutate(ctx, action === 'add' ? 'POST' : 'PATCH', `/v4/me/addresses${action === 'add' ? '' : `/${id(args[0])}`}`, body);
  });
  runtime.action(address.command('delete <id>'), async (ctx, [value]) => mutate(ctx, 'DELETE', `/v4/me/addresses/${id(value)}`, undefined, '배송지를 삭제할까요?'));
  runtime.action(address.command('default <id>'), async (ctx, [value]) => mutate(ctx, 'PATCH', `/v4/me/addresses/${id(value)}/default`));
  const email = me.command('email').description('이메일 알림 주소 인증·설정');
  for (const action of ['send', 'verify'] as const) runtime.action(email.command(action === 'send' ? 'send <email>' : 'verify <email> <code>'), async (ctx, [address, code]) => {
    const target = parse(emailSchema, address);
    if (action === 'verify') parse(z.string().regex(/^\d{6}$/), code);
    const body = { type: 'notification_email', target, ...(action === 'verify' ? { code } : {}) };
    const path = `/v4/auth/verification/${action}`;
    if (dryRun(ctx, 'POST', path, body)) return;
    ctx.output(await ctx.api.request('POST', path, { body, auth: false }));
  });
  runtime.action(email.command('set').option('--email <email>', '인증한 이메일').option('--verification-id <id>', '인증 결과 ID').option('--enabled <on|off>', '이메일 알림', onOff), async (ctx, _args, opts) => {
    const body: Record<string, unknown> = {};
    if (opts.email !== undefined) { body.email = parse(emailSchema, opts.email); body.email_verification_id = id(opts.verificationId); }
    else if (opts.verificationId) throw new CliError('--verification-id는 --email과 함께 지정하세요.');
    if (opts.enabled !== undefined) body.enabled = opts.enabled;
    nonempty(body); await mutate(ctx, 'PATCH', '/v4/me/email-notification', body);
  });
}
