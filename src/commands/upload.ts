import type { Command } from 'commander';
import type { Runtime } from '../core/types.js';
import { prepareImages, uploadPrepared } from '../lib/images.js';
export function registerUploadCommands(program: Command, runtime: Runtime): void {
  runtime.action(program.command('upload <files...>').description('이미지를 업로드하고 CDN 주소 출력'), async (ctx, args) => {
    const prepared = await prepareImages(args.flat());
    if (ctx.options.dryRun) { ctx.output({ dry_run: true, files: prepared.map(({ source, width, height }) => ({ source, width, height })) }); return; }
    const results = []; for (const image of prepared) results.push(await uploadPrepared(ctx, image));
    ctx.output(results);
  });
}
