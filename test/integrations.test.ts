import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, rm, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcpConfiguration } from '../src/commands/integrations.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const secret = `pat_${'d'.repeat(64)}`;
function run(directory: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, CLACK_CONFIG_DIR: directory, CLACK_TOKEN: secret, ...extra };
  delete env.CLACK_API_BASE; delete env.CLACK_PROFILE; delete env.CLACK_LANG;
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root, env, encoding: 'utf8' });
}

test('MCP 안내는 자격 파일을 읽거나 바꾸지 않고 실제 토큰 없이 환경변수 참조를 출력한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-mcp-config-'));
  try {
    const credentialPath = join(directory, 'credentials.json');
    await writeFile(credentialPath, '읽을 수 없는 JSON');
    if (process.platform !== 'win32') await chmod(credentialPath, 0o640);
    const mode = (await stat(credentialPath)).mode;
    const plain = run(directory, ['mcp', 'config', '--print']);
    assert.equal(plain.status, 0, plain.stderr);
    const config = JSON.parse(plain.stdout);
    assert.equal(config.mcpServers.clack.headers.Authorization, 'Bearer ${CLACK_TOKEN}');
    assert.equal(config.mcpServers.clack.url, 'https://v4-api.clack.kr/v4/mcp');
    const json = run(directory, ['mcp', 'config', '--json', '--base-url', 'http://127.0.0.1:8765']);
    assert.equal(json.status, 0, json.stderr);
    const envelope = JSON.parse(json.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.url, 'http://127.0.0.1:8765/v4/mcp');
    assert.equal(envelope.data.claude_config.mcpServers.clack.headers.Authorization, 'Bearer ${CLACK_TOKEN}');
    assert.equal(envelope.time_contract, 'utc-v1');
    assert.ok(!(plain.stdout + plain.stderr + json.stdout + json.stderr).includes(secret));
    assert.equal(await readFile(credentialPath, 'utf8'), '읽을 수 없는 JSON');
    assert.equal((await stat(credentialPath)).mode, mode);
    assert.deepEqual(await readdir(directory), ['credentials.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('MCP 설정은 선택 프로필 원점과 출력 선호를 사용하고 상충 옵션을 거부한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-mcp-profile-'));
  try {
    await writeFile(join(directory, 'config.json'), JSON.stringify({ profiles: { custom: { base_url: 'https://api.example.com', output: 'json' } } }));
    const result = run(directory, ['--profile', 'custom', 'mcp', 'config']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).data.url, 'https://api.example.com/v4/mcp');
    const codex = run(directory, ['mcp', 'config', '--codex']);
    assert.equal(codex.status, 0, codex.stderr);
    assert.match(codex.stdout, /bearer_token_env_var = "CLACK_TOKEN"/);
    assert.match(codex.stdout, /\[mcp_servers.clack\]/);
    const invalid = run(directory, ['mcp', 'config', '--claude', '--codex', '--json']);
    assert.equal(invalid.status, 6);
    assert.equal(JSON.parse(invalid.stdout).code, 'INVALID_ARGUMENT');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Claude 등록 명령은 POSIX 셸을 지나도 헤더 환경변수를 원문 참조로 보존한다', { skip: process.platform === 'win32' }, () => {
  const config = mcpConfiguration('https://v4-api.clack.kr');
  const result = spawnSync('sh', ['-c', `claude() { printf '%s\\n' "$@"; }; ${config.claude_command}`], { encoding: 'utf8', env: { ...process.env, CLACK_TOKEN: secret } });
  assert.equal(result.status, 0, result.stderr);
  const args = result.stdout.trim().split('\n');
  assert.deepEqual(args.slice(0, 4), ['mcp', 'add-json', '--scope', 'project']);
  assert.equal(args[4], 'clack');
  assert.equal(JSON.parse(args[5]!).headers.Authorization, 'Bearer ${CLACK_TOKEN}');
  assert.ok(!result.stdout.includes(secret));
});

test('스킬 안내는 로그인·설치 없이 출력하고 잘못된 API 원점은 MCP 설정으로 내보내지 않는다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clack-skills-info-'));
  try {
    const result = run(directory, ['skills', '--json'], { CLACK_TOKEN: '유효하지 않은 토큰' });
    assert.equal(result.status, 0, result.stderr);
    const skillsData = JSON.parse(result.stdout).data;
    assert.equal(skillsData.install, 'npx skills add clack-project/skills');
    assert.equal(skillsData.repository, 'https://github.com/clack-project/skills');
    assert.ok(skillsData.message.includes('https://github.com/clack-project/skills'));
    assert.ok(!skillsData.message.includes('정식 배포 후'), '미공개 전제 문구가 남아있으면 안 된다');
    assert.deepEqual(await readdir(directory), []);
    const invalid = run(directory, ['mcp', 'config', '--base-url', 'https://user:password@example.com', '--json']);
    assert.equal(invalid.status, 6);
    assert.ok(!invalid.stdout.includes('password'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
