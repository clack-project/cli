import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (tag !== `v${pkg.version}` || pkg.name !== '@clack-platform/cli') {
  process.stderr.write('배포 태그와 CLI 패키지 이름·버전이 일치하지 않습니다.\n');
  process.exitCode = 1;
} else {
  process.stdout.write(`${pkg.name}@${pkg.version} 배포 태그 확인 완료\n`);
}
