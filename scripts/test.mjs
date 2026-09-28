import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Windows·Node 20에서도 셸의 와일드카드 확장에 의존하지 않는다.
const files = readdirSync(new URL('../test/', import.meta.url)).filter(name => name.endsWith('.test.ts')).map(name => `test/${name}`);
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
