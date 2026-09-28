import type { Command } from 'commander';
import type { Runtime } from '../core/types.js';
import { validateConfigValue, type ConfigStore } from '../core/config.js';

export function registerConfigCommands(program: Command, runtime: Runtime, store: ConfigStore): void {
  const config = program.command('config').description('프로필별 CLI 설정');
  runtime.action(config.command('get').argument('[key]'), async (ctx, [key]) => {
    const resolved = await store.resolve(ctx.options, true);
    const saved = await store.getConfig(resolved.profile);
    ctx.output(key ? { [key]: saved[key as keyof typeof saved] ?? null } : { profile: resolved.profile, ...saved, base_url: resolved.baseUrl });
  });
  runtime.action(config.command('set <key> <value>'), async (ctx, [key, value]) => {
    const resolved = await store.resolve(ctx.options, true);
    const validated = validateConfigValue(key!, value!);
    if (!ctx.options.dryRun) await store.setConfig(resolved.profile, key!, validated);
    ctx.output({ key, value: validated, ...(ctx.options.dryRun ? { dry_run: true } : {}) });
  });
}
