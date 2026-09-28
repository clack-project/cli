#!/usr/bin/env node
import { registerAuthoringCommands } from './commands/authoring.js';
import { Command, CommanderError, Option } from 'commander';
import { VERSION } from './core/api.js';
import { ConfigStore } from './core/config.js';
import { asCliError, CliError } from './core/errors.js';
import { CliRuntime } from './core/runtime.js';
import { redact, redactText, rememberSecret } from './core/secrets.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerConfigCommands } from './commands/config.js';
import { registerMeCommands } from './commands/me.js';
import { registerProductCommands } from './commands/product.js';
import { registerPostCommands } from './commands/post.js';
import { registerChannelCommands } from './commands/channel.js';
import { registerUploadCommands } from './commands/upload.js';
import { registerIntegrationCommands } from './commands/integrations.js';
import { registerContentCommands } from './commands/content.js';
import { registerPageCommands } from './commands/page.js';
import { registerSkillCommands } from './commands/skill.js';
import { registerPlatformCommands } from './commands/platform.js';

const program = new Command().name('clack').description('클랙 상품·콘텐츠·프로필 관리').version(VERSION)
  .option('--json', '기계 처리용 JSON 출력').option('-y, --yes', '파괴적 작업 확인')
  .option('--profile <name>', '연결 프로필').option('--verbose', '요청 메서드·경로·시간 계약 표시')
  .addOption(new Option('--env <environment>', 'API 환경').choices(['prod', 'dev']))
  .option('--base-url <url>', 'API 원점 직접 지정')
  .addOption(new Option('--time <mode>', '사람용 시각 표시').choices(['local', 'utc']))
  .option('--dry-run', '입력 검증과 미리보기만 수행');

// 파서 오류가 입력값을 인용해도 토큰이 노출되지 않게 파싱 전 등록한다.
for (const arg of process.argv.slice(2)) if (/^(?:pat_|dvc_)/.test(arg)) rememberSecret(arg);
if (process.env.CLACK_TOKEN) rememberSecret(process.env.CLACK_TOKEN);
if (process.env.CLACK_SERVER_KEY) rememberSecret(process.env.CLACK_SERVER_KEY);
program.configureOutput({ writeErr: () => {}, writeOut: text => process.stdout.write(redactText(text)) }).exitOverride();
const store = new ConfigStore();
const runtime = new CliRuntime(store);
registerAuthCommands(program, runtime, store);
registerConfigCommands(program, runtime, store);
registerMeCommands(program, runtime);
registerProductCommands(program, runtime);
registerPostCommands(program, runtime);
registerChannelCommands(program, runtime);
registerUploadCommands(program, runtime);
registerIntegrationCommands(program, runtime);
registerContentCommands(program, runtime);
registerPageCommands(program, runtime);
registerSkillCommands(program, runtime);
registerPlatformCommands(program, runtime);
registerAuthoringCommands(program, runtime);

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) process.exitCode = 0;
  else {
    const failure = error instanceof CommanderError ? new CliError(error.message, 'INVALID_ARGUMENT') : asCliError(error);
    const envelope = redact({ ok: false, status: failure.status, code: failure.code, message: failure.message,
      ...(failure.retryAfter ? { retry_after: failure.retryAfter } : {}) });
    const json = program.opts().json || process.argv.includes('--json') || await store.resolve(program.opts(), true).then(value => value.options.json).catch(() => false);
    if (json) process.stdout.write(JSON.stringify(envelope) + '\n');
    else process.stderr.write(redactText(`[${failure.code}] ${failure.message}\n`));
    process.exitCode = failure.exitCode;
  }
}
