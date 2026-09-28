import type { Command } from 'commander';
import type { ApiClient } from './api.js';

export type TimeContract = 'utc-v1' | 'legacy-kst';
export interface ApiResult<T = unknown> {
  data: T;
  pagination?: { next_cursor?: string | number | null; has_more?: boolean };
  time_contract: TimeContract;
}
export interface GlobalOptions {
  json?: boolean; yes?: boolean; profile?: string; verbose?: boolean;
  time?: 'local' | 'utc'; dryRun?: boolean; env?: 'prod' | 'dev'; baseUrl?: string;
}
export interface CommandContext {
  api: ApiClient;
  options: GlobalOptions;
  output(result: ApiResult | unknown): void;
  confirm(message: string): Promise<void>;
}
export interface Runtime {
  action(command: Command, handler: (ctx: CommandContext, args: string[], opts: Record<string, any>) => Promise<void>): void;
}
