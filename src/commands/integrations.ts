import { Option, type Command } from 'commander';
import { VERSION } from '../core/api.js';
import { validateBaseUrl } from '../core/config.js';
import { redactText } from '../core/secrets.js';
import type { Runtime } from '../core/types.js';
import { servePlatformMcp } from '../lib/platform-mcp.js';

export const SKILLS_REPOSITORY = 'https://github.com/clack-project/skills';

/** POSIX 셸에서 환경변수 참조를 확장하지 않는 단일 인자로 만든다. */
function quoteArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function mcpConfiguration(baseUrl: string) {
  const url = `${validateBaseUrl(redactText(baseUrl))}/v4/mcp`;
  const server = { type: 'http', url, headers: { Authorization: 'Bearer ${CLACK_TOKEN}' } };
  return {
    url,
    claude_config: { mcpServers: { clack: server } },
    claude_command: `claude mcp add-json --scope project clack ${quoteArgument(JSON.stringify(server))}`,
    codex_config: `[mcp_servers.clack]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "CLACK_TOKEN"`,
    codex_command: `codex mcp add clack --url ${quoteArgument(url)} --bearer-token-env-var CLACK_TOKEN`,
  };
}

export function platformMcpConfiguration(baseUrl: string) {
  const origin = validateBaseUrl(redactText(baseUrl));
  const server = { command: 'clack', args: ['mcp', 'serve-platform', '--base-url', origin] };
  return {
    origin,
    claude_config: { mcpServers: { clack_platform: server } },
    claude_command: `claude mcp add-json --scope project clack-platform ${quoteArgument(JSON.stringify(server))}`,
    codex_config: `[mcp_servers.clack_platform]\ncommand = "clack"\nargs = ${JSON.stringify(server.args)}`,
  };
}

export function registerIntegrationCommands(program: Command, runtime: Runtime): void {
  const mcp = program.command('mcp').description('MCP 클라이언트 연결·플랫폼 조회 도구');
  runtime.action(mcp.command('config').description('토큰 없는 MCP 설정 출력 (파일 변경·서버 요청 없음)')
    .option('--platform', 'CLACK_SERVER_KEY를 사용하는 로컬 플랫폼 조회 서버 설정')
    .addOption(new Option('--print', 'Claude Code .mcp.json 조각 출력 (기본)').conflicts(['claude', 'codex']))
    .addOption(new Option('--claude', 'Claude Code 등록 명령 출력').conflicts(['print', 'codex']))
    .addOption(new Option('--codex', 'Codex config.toml 조각 출력').conflicts(['print', 'claude'])), async (ctx, _args, opts) => {
    const config = opts.platform ? platformMcpConfiguration(ctx.api.settings.baseUrl) : mcpConfiguration(ctx.api.settings.baseUrl);
    const instructions = opts.platform
      ? '에이전트 실행 환경에 콘텐츠 서버 키 도구는 발급받은 서버 키를 CLACK_SERVER_KEY로, 스킬·콘텐츠 공개·공유 문서 도구는 platform:read·platform:write(필요 시 skill:*·creator-content:publish) 권한의 개인 액세스 토큰을 CLACK_TOKEN으로 설정하세요. 필요한 도구만큼만 설정하면 됩니다. 설정 출력에는 키·토큰 원문을 넣지 않습니다. 환경과 설정 원점이 일치하는지 확인하세요.'
      : '앱에서 발급한 개인 액세스 토큰을 에이전트 실행 환경의 CLACK_TOKEN에 안전하게 설정하세요. CLI에 저장된 토큰은 자동 전달되지 않습니다. 토큰을 대화·명령 기록·설정 파일에 붙여 넣지 마세요. CLI 프로필을 바꾸어도 기존 MCP 설정은 갱신되지 않으므로 URL과 토큰의 계정을 확인하세요.';
    // 인증 헤더의 고정 환경변수 참조를 보존한다. 이 경로는 자격 파일·API 응답을 읽지 않는다.
    if (ctx.options.json) process.stdout.write(JSON.stringify({ ok: true, data: { ...config,
      token_env: opts.platform ? 'CLACK_SERVER_KEY' : 'CLACK_TOKEN', instructions }, time_contract: 'utc-v1' }) + '\n');
    else {
      process.stderr.write(instructions + '\n');
      process.stdout.write((opts.claude ? config.claude_command : opts.codex ? config.codex_config : JSON.stringify(config.claude_config, null, 2)) + '\n');
    }
  });
  runtime.action(mcp.command('serve-platform').description('플랫폼 서버 키 조회 도구를 MCP stdio로 제공'),
    async (ctx) => servePlatformMcp(ctx.api.settings));
  runtime.action(program.command('skills').description('에이전트 스킬 설치 방법 안내'), async ctx => {
    ctx.output({ repository: SKILLS_REPOSITORY, minimum_cli_version: '0.1.0', cli_version: VERSION,
      install: 'npx skills add clack-project/skills',
      install_global: 'npx skills add clack-project/skills -g',
      install_selected: 'npx skills add clack-project/skills -s clack-products',
      update: 'npx skills update', remove: 'npx skills remove',
      message: `공개 저장소 ${SKILLS_REPOSITORY}에서 npx skills로 설치합니다. 이 명령은 안내만 출력하며 설치나 로그인을 실행하지 않습니다.`,
    });
  });
}
