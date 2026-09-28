import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// 공개 CLI 패키지는 서버에 의존하지 않지만, 나란히 체크아웃한 모노레포가 있으면 CLI·MCP 입력
// 스키마가 계속 같은지 확인한다. 모노레포가 없으면(공개 저장소 단독 체크아웃) 건너뛴다.
const strict = process.argv.includes('--strict');
const monorepoDir = resolve(process.env.CLACK_MONOREPO_DIR ?? '../clack');
const mcpSchemasDir = resolve(monorepoDir, 'clack-api-v4/src/lib/user-mcp-schemas');

if (!existsSync(mcpSchemasDir)) {
  if (strict) {
    process.stderr.write(`모노레포 없음(${mcpSchemasDir}) — --strict에서는 건너뛸 수 없습니다.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`모노레포 없음(${mcpSchemasDir}) — CLI·MCP 스키마 동기화 확인을 건너뜁니다.\n`);
  }
} else {
  for (const name of ['categories', 'product', 'post', 'me', 'channel']) {
    const [cli, mcp] = await Promise.all([
      readFile(new URL(`../src/schemas/${name}.ts`, import.meta.url), 'utf8'),
      readFile(resolve(mcpSchemasDir, `${name}.ts`), 'utf8'),
    ]);
    assert.equal(mcp, cli, `${name}.ts 스키마가 다릅니다. CLI와 MCP 복사본을 함께 갱신하세요.`);
  }
  process.stdout.write('CLI·MCP 입력 스키마 동기화 확인 완료\n');
}
