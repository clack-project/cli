import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'clack-package-check-'));
const npm = process.platform === 'win32' ? process.execPath : 'npm';
const npmPrefix = process.platform === 'win32' ? [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')] : [];

function run(command, args, cwd) {
  const env = { ...process.env, npm_config_cache: join(temporary, 'npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false' };
  // 바깥 npm exec가 설정한 패키지를 임시 설치 검증에서 다시 요청하지 않는다.
  for (const key of Object.keys(env)) if (['npm_config_package', 'npm_config_call'].includes(key.toLowerCase())) delete env[key];
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', timeout: 120_000,
    // Windows에서도 셸을 거치지 않고 Node.js 설치에 포함된 npm CLI를 직접 실행한다.
    env,
  });
  assert.equal(result.status, 0, `패키지 검증 명령 실패: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

try {
  const [packed] = JSON.parse(run(npm, [...npmPrefix, 'pack', '--json', '--ignore-scripts', '--pack-destination', temporary], root));
  assert.equal(packed.name, '@clack-platform/cli');
  assert.equal(packed.version, pkg.version);
  const paths = packed.files.map((file) => file.path);
  for (const required of ['dist/cli.js', 'README.md', 'LICENSE', 'package.json']) {
    assert(paths.includes(required), `배포 파일 누락: ${required}`);
  }
  assert(paths.every((path) => path.startsWith('dist/') || ['README.md', 'LICENSE', 'package.json'].includes(path)), '배포 범위 밖 파일 포함');
  assert(!Object.keys(pkg.dependencies ?? {}).includes('@clack/types'), '내부 타입 패키지 런타임 의존성 금지');
  assert.match(await readFile(join(root, 'dist/cli.js'), 'utf8'), /^#!\/usr\/bin\/env node\r?\n/);
  run(npm, [...npmPrefix, 'install', '--prefix', temporary, '--ignore-scripts', '--no-package-lock', join(temporary, packed.filename)], temporary);
  const installed = join(temporary, 'node_modules/@clack-platform/cli/dist/cli.js');
  assert.equal(run(process.execPath, [installed, '--version'], temporary), pkg.version);
  assert.match(run(process.execPath, [installed, '--help'], temporary), /login/);
  assert.equal(run(npm, [...npmPrefix, 'exec', '--offline', '--no', '--', 'clack', '--version'], temporary), pkg.version);
  process.stdout.write(JSON.stringify({ ok: true, name: packed.name, version: packed.version, files: paths, installed: true }) + '\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
