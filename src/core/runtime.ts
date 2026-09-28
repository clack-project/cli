import { confirm } from '@inquirer/prompts';
import type { Command } from 'commander';
import { ApiClient } from './api.js';
import { ConfigStore } from './config.js';
import { CliError } from './errors.js';
import { redact } from './secrets.js';
import { displayData } from './time.js';
import type { ApiResult, CommandContext, GlobalOptions, Runtime } from './types.js';

export function output(result: unknown, options: GlobalOptions): void {
  const envelope = result && typeof result === 'object' && 'time_contract' in result && 'data' in result
    ? result as ApiResult : { data: result, time_contract: 'utc-v1' as const };
  const safe = redact(envelope) as ApiResult;
  if (options.json) { process.stdout.write(JSON.stringify({ ok: true, ...safe }) + '\n'); return; }
  const display = displayData(safe.data, safe.time_contract, options.time ?? 'local');
  if (Array.isArray(display) && display.length > 0 && display.every(item => item && typeof item === 'object')) console.table(display);
  else process.stdout.write((typeof display === 'string' ? display : JSON.stringify(display, null, 2)) + '\n');
  if (safe.pagination?.has_more) process.stdout.write(`다음 커서: ${safe.pagination.next_cursor}\n`);
}

export class CliRuntime implements Runtime {
  constructor(public readonly store = new ConfigStore()) {}
  action(command: Command, handler: (ctx: CommandContext, args: string[], opts: Record<string, any>) => Promise<void>): void {
    command.action(async (...values: unknown[]) => {
      const cmd = values.at(-1) as Command;
      const opts = cmd.optsWithGlobals();
      const localSkillValidation = cmd.parent?.name() === 'skill' && cmd.name() === 'validate' && !opts.remote;
      const platformCommand = cmd.parent?.name() === 'platform' || cmd.parent?.parent?.name() === 'platform';
      const resolved = await this.store.resolve(opts, localSkillValidation || platformCommand || ['login', 'config', 'skills', 'mcp'].includes(cmd.name()) || ['config', 'mcp'].includes(cmd.parent?.name() ?? ''));
      const ctx: CommandContext = {
        api: new ApiClient({ baseUrl: resolved.baseUrl, token: resolved.token, lang: resolved.lang, verbose: opts.verbose, dryRun: opts.dryRun }),
        options: resolved.options,
        output: result => output(result, resolved.options),
        confirm: async message => {
          if (opts.dryRun || opts.yes) return;
          if (!process.stdin.isTTY || !process.stdout.isTTY) throw new CliError('이 명령은 확인이 필요합니다. 비대화형 실행에는 --yes를 지정하세요.', 'CONFIRMATION_REQUIRED');
          if (!await confirm({ message, default: false })) throw new CliError('작업을 취소했습니다.', 'CANCELLED');
        },
      };
      await handler(ctx, values.slice(0, -2) as string[], opts);
    });
  }
}
