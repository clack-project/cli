import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// CLI는 이제 모노레포와 분리된 저장소다. `@clack/types`와 clack-api-v4의 공개 제작 계약(스킬·폼·
// 콘텐츠 JSON 스키마, 의미 검증 함수) 중 CLI가 실제로 쓰는 파일만 src/vendor/ 아래 그대로 복사해
// 둔다. `platform.generated.ts`는 관리자·런타임 연산까지 포함한 전체 API 표면(200여 개 연산,
// `/v4/admin/*` 포함)이므로 통째로 복사하지 않고, CLI(`platform` 명령)가 실제로 쓰는 서버 키
// 데이터 연산만 TypeScript 컴파일러 API로 골라내 별도 파일로 만든다. 이 스크립트는 나란히
// 체크아웃한 모노레포(CLACK_MONOREPO_DIR, 기본 ../clack)에서 다시 복사·추출하거나(기본),
// `--check`로 vendor 사본이 원본에서 다시 뽑아낸 결과와 여전히 같은지만 검사한다. 모노레포가
// 없으면(공개 저장소 단독 체크아웃) 아무 일도 하지 않고 성공으로 끝낸다.

const cliRoot = fileURLToPath(new URL('..', import.meta.url));
const monorepoDir = resolve(cliRoot, process.env.CLACK_MONOREPO_DIR ?? '../clack');
const check = process.argv.includes('--check');

function tsHeader(source) {
  return `/** 모노레포 ${source}에서 복사한 파일이다. 이 파일을 직접 수정하지 말고\n * \`scripts/sync-vendor-types.mjs\`로 갱신한다. */\n`;
}
function mjsHeader(source) {
  return `// 모노레포 ${source}에서 복사한 파일이다. 이 파일을 직접 수정하지 말고\n// scripts/sync-vendor-types.mjs로 갱신한다.\n`;
}
function withTsHeader(source, content) { return tsHeader(source) + content; }
function withMjsHeader(source, content) { return mjsHeader(source) + content; }
function withJsonComment(source, content) {
  const comment = `모노레포 ${source}에서 복사한 파일이다. 이 파일을 직접 수정하지 말고 scripts/sync-vendor-types.mjs로 갱신한다.`;
  return content.replace(/("\$id":\s*"[^"]*",)/, `$1\n  "$comment": ${JSON.stringify(comment)},`);
}

// CLI `platform` 명령(src/commands/platform.ts)이 실제로 참조하는 PlatformApiOperations 키만
// 남긴다. 새 연산을 CLI에 추가하면 여기에도 더해야 한다(빠뜨리면 sync가 '연산을 찾을 수 없음'으로
// 실패한다).
const SERVER_OPERATIONS = [
  'getServerUsage',
  'getServerDocument',
  'putServerDocument',
  'patchServerDocument',
  'deleteServerDocument',
  'listServerDocuments',
  'getServerLeaderboard',
];

/** platform.generated.ts(전체 API 표면, 관리자·런타임 연산 포함)에서 SERVER_OPERATIONS와 그
 * 전이 참조 타입만 TS AST로 골라 부분집합 .ts를 만든다. 수작업 복사가 아니라 매번 원본을 다시
 * 파싱해서 뽑아내므로 원본이 바뀌면(연산 삭제·타입 이름 변경 등) 이 함수도 함께 실패하거나
 * 갱신된다. */
function extractPlatformServerTypes(source, content) {
  const sourceFile = ts.createSourceFile('platform.generated.ts', content, ts.ScriptTarget.Latest, true);
  const typeAliasText = new Map();
  const typeAliasOrder = [];
  const operationsMembers = new Map();
  const slice = (node) => content.slice(node.getStart(sourceFile), node.getEnd());

  for (const statement of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(statement)) {
      typeAliasText.set(statement.name.text, slice(statement));
      typeAliasOrder.push(statement.name.text);
    } else if (ts.isInterfaceDeclaration(statement) && statement.name.text === 'PlatformApiOperations') {
      for (const member of statement.members) {
        if (ts.isPropertySignature(member) && member.name && ts.isStringLiteral(member.name)) {
          operationsMembers.set(member.name.text, slice(member));
        }
      }
    }
  }

  const missingOps = SERVER_OPERATIONS.filter((name) => !operationsMembers.has(name));
  if (missingOps.length) {
    throw new Error(`${source}에서 연산을 찾을 수 없습니다: ${missingOps.join(', ')} (SERVER_OPERATIONS·원본 스키마를 확인하세요)`);
  }

  // 선택한 연산이 참조하는 타입, 그 타입이 다시 참조하는 타입까지 고정점까지 전이 확장한다.
  const identifierPattern = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  const included = new Set();
  const queue = [];
  function enqueueReferences(text) {
    for (const match of text.matchAll(identifierPattern)) {
      const name = match[0];
      if (typeAliasText.has(name) && !included.has(name)) { included.add(name); queue.push(name); }
    }
  }
  for (const opName of SERVER_OPERATIONS) enqueueReferences(operationsMembers.get(opName));
  while (queue.length) enqueueReferences(typeAliasText.get(queue.shift()));

  const typeBlock = typeAliasOrder.filter((name) => included.has(name)).map((name) => typeAliasText.get(name)).join('\n');
  const operationsBlock = SERVER_OPERATIONS.map((name) => `  ${operationsMembers.get(name)}`).join('\n');
  return `// 원본 안내: 공개 JSON Schema와 OpenAPI에서 자동 생성합니다. 직접 수정하지 마세요.\n`
    + `// 조건부 제약·문자열 패턴·수치 범위는 런타임 스키마 검증이 최종 기준입니다.\n\n`
    + `${typeBlock}\n\nexport interface PlatformApiOperations {\n${operationsBlock}\n}\n`;
}
function withPlatformServerSubset(source, content) {
  return `/** 모노레포 ${source}에서 CLI(src/commands/platform.ts)가 실제로 쓰는 서버 키 데이터 연산\n`
    + ` * (${SERVER_OPERATIONS.join(', ')})과 그 참조 타입만 scripts/sync-vendor-types.mjs로 추출한\n`
    + ` * 부분집합이다. 원본에는 관리자·런타임 연산까지 포함된 전체 API 표면이 있으나 이 파일에는\n`
    + ` * 포함하지 않는다. 이 파일을 직접 수정하지 말고 \`scripts/sync-vendor-types.mjs\`로 갱신한다. */\n`
    + extractPlatformServerTypes(source, content);
}

// [모노레포 상대 경로, vendor 목적지 상대 경로, 변환 함수]. vendor/ 아래 구성의 단일 원본 목록이다.
const ENTRIES = [
  { source: 'clack-types/models/channel.ts', dest: 'src/vendor/clack-types/models/channel.ts', transform: withTsHeader },
  { source: 'clack-types/models/user.ts', dest: 'src/vendor/clack-types/models/user.ts', transform: withTsHeader },
  { source: 'clack-types/models/trade-review.ts', dest: 'src/vendor/clack-types/models/trade-review.ts', transform: withTsHeader },
  { source: 'clack-types/custom-pages.ts', dest: 'src/vendor/clack-types/custom-pages.ts', transform: withTsHeader },
  { source: 'clack-types/platform.generated.ts', dest: 'src/vendor/clack-types/platform-server.generated.ts', transform: withPlatformServerSubset },
  { source: 'clack-api-v4/contracts/platform/authoring-semantics.mjs', dest: 'src/vendor/clack-api-v4-contracts/authoring-semantics.mjs', transform: withMjsHeader },
  { source: 'clack-api-v4/contracts/platform/authoring-semantics.d.mts', dest: 'src/vendor/clack-api-v4-contracts/authoring-semantics.d.mts', transform: withTsHeader },
  { source: 'clack-api-v4/contracts/platform/schemas/clack-skill.v1.schema.json', dest: 'src/vendor/clack-api-v4-contracts/schemas/clack-skill.v1.schema.json', transform: withJsonComment },
  { source: 'clack-api-v4/contracts/platform/schemas/authoring-form.v1.schema.json', dest: 'src/vendor/clack-api-v4-contracts/schemas/authoring-form.v1.schema.json', transform: withJsonComment },
  { source: 'clack-api-v4/contracts/platform/schemas/clack-content.v1.schema.json', dest: 'src/vendor/clack-api-v4-contracts/schemas/clack-content.v1.schema.json', transform: withJsonComment },
];

if (!existsSync(monorepoDir)) {
  process.stdout.write(`모노레포 없음(${monorepoDir}) — vendor 동기화를 건너뜁니다.\n`);
  process.exit(0);
}

const missing = [];
const drifted = [];
const failed = [];
for (const entry of ENTRIES) {
  const sourcePath = resolve(monorepoDir, entry.source);
  const destPath = resolve(cliRoot, entry.dest);
  if (!existsSync(sourcePath)) { missing.push(entry.source); continue; }
  let rendered;
  try {
    rendered = entry.transform(entry.source, readFileSync(sourcePath, 'utf8'));
  } catch (error) {
    failed.push(`${entry.dest}: ${error.message}`);
    continue;
  }
  if (check) {
    const current = existsSync(destPath) ? readFileSync(destPath, 'utf8') : null;
    if (current !== rendered) drifted.push(entry.dest);
  } else {
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, rendered);
    process.stdout.write(`갱신: ${entry.dest}\n`);
  }
}

if (missing.length) {
  process.stderr.write(`모노레포에서 찾을 수 없는 원본: ${missing.join(', ')}\n`);
  process.exitCode = 1;
}
if (failed.length) {
  process.stderr.write(`추출 실패:\n${failed.map((line) => `  ${line}`).join('\n')}\n`);
  process.exitCode = 1;
}
if (check) {
  if (drifted.length) {
    process.stderr.write(`vendor 사본이 모노레포 원본과 다릅니다: ${drifted.join(', ')}\nnode scripts/sync-vendor-types.mjs 로 갱신하세요.\n`);
    process.exitCode = 1;
  } else if (!missing.length && !failed.length) {
    process.stdout.write('vendor 사본이 모노레포 원본과 일치합니다.\n');
  }
}
