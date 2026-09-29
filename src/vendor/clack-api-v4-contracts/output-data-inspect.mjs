// 모노레포 clack-api-v4/contracts/platform/validators.mjs의 데이터 스키마 검사 구간만 scripts/sync-vendor-types.mjs로 추출한 파일이다. 직접 수정하지 않는다.
import { walkDataSchema } from './authoring-semantics.mjs';
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const fail = (path, message) => ({ path, message });
// 스킬 에디터 데이터 문서 스키마(output-data.v1). 메타 스키마로 표현할 수 없는 깊이·필수 상한·판별자·참조·비공개 경계를 검사한다.
export const OUTPUT_DATA_LIMITS = { schema_bytes: 65536, depth: 6, properties: 400, public_bytes: 262144, private_bytes: 65536, ui_state_bytes: 262144 };
// v1은 데이터 스키마의 pattern을 허용하지 않는다(메타 스키마가 거부, 백트래킹 DoS 방지). uniqueItems는 스칼라 배열에만 쓴다.
const SCALAR_TYPES = new Set(['string', 'integer', 'number', 'boolean']);
const SCALAR_KEYS = { string: ['minLength', 'maxLength', 'format'], number: ['minimum', 'maximum'], integer: ['minimum', 'maximum'],
  array: ['items', 'minItems', 'maxItems', 'uniqueItems'], object: ['properties', 'required', 'additionalProperties'], boolean: [] };
const TYPED_KEYS = new Set(Object.values(SCALAR_KEYS).flat());
export function inspectOutputData(schema) {
  const errors = [];
  if (bytes(schema) > OUTPUT_DATA_LIMITS.schema_bytes) errors.push(fail('/', '데이터 스키마는 64 KiB 이하이어야 합니다.'));
  for (const name of schema.required ?? []) if (!Object.hasOwn(schema.properties, name)) errors.push(fail('/required', `선언하지 않은 루트 키 ${name}입니다.`));
  if (!Object.values(schema.properties).some((field) => field['x-clack-visibility'] === 'public')) errors.push(fail('/properties', '공개 루트 키가 하나 이상 필요합니다.'));
  const defs = schema.$defs ?? {};
  const resolve = (node) => typeof node?.$ref === 'string' ? defs[node.$ref.slice('#/$defs/'.length)] : node;
  let properties = 0;
  const suggestRoots = [];
  const assetPointers = [];
  walkDataSchema(schema, (node, info) => {
    const at = info.pointer || '/';
    if (info.cycle) { errors.push(fail(at, '순환 참조는 허용하지 않습니다.')); return; }
    if (info.unresolved) { errors.push(fail(at, '로컬 $defs 참조만 허용합니다.')); return; }
    if (info.depth > OUTPUT_DATA_LIMITS.depth) errors.push(fail(at, '데이터 문서 깊이는 루트 아래 6 이하이어야 합니다.'));
    if (info.depth === 0) return;
    if (typeof node.$ref === 'string') {
      if (Object.keys(node).some((key) => !['$ref', 'title', 'description', 'x-clack-i18n', 'x-clack-visibility'].includes(key))) errors.push(fail(at, '$ref에는 설명 키만 함께 둘 수 있습니다.'));
      return;
    }
    if (!info.branch) properties++;
    if (Array.isArray(node.oneOf)) {
      const discriminator = node['x-clack-discriminator'];
      if (!discriminator) errors.push(fail(at, 'oneOf에는 x-clack-discriminator가 필요합니다.'));
      if (node.type || node.properties || node.items || node.enum || Object.hasOwn(node, 'const')) errors.push(fail(at, 'oneOf 노드에는 형식 키를 함께 둘 수 없습니다.'));
      const seen = new Set();
      for (const raw of node.oneOf) {
        const branch = resolve(raw);
        const tag = branch?.properties?.[discriminator];
        if (branch?.type !== 'object' || typeof tag?.const !== 'string' || tag.type !== 'string' || !(branch.required ?? []).includes(discriminator)) {
          errors.push(fail(at, '각 oneOf 분기는 판별자 문자열 const를 필수로 가진 객체여야 합니다.'));
        } else if (seen.has(tag.const)) errors.push(fail(at, `판별자 값 ${tag.const}이 중복됩니다.`));
        else seen.add(tag.const);
      }
      return;
    }
    if (node['x-clack-discriminator'] !== undefined) errors.push(fail(at, 'x-clack-discriminator는 oneOf에만 둡니다.'));
    if (!node.type) { errors.push(fail(at, 'type이 필요합니다.')); return; }
    for (const key of Object.keys(node)) if (TYPED_KEYS.has(key) && !SCALAR_KEYS[node.type].includes(key)) errors.push(fail(`${at}/${key}`, `${node.type}에 쓸 수 없는 키입니다.`));
    const range = (low, high, label) => { if (typeof node[low] === 'number' && typeof node[high] === 'number' && node[low] > node[high]) errors.push(fail(at, `${label} 범위가 잘못되었습니다.`)); };
    range('minLength', 'maxLength', '길이'); range('minItems', 'maxItems', '항목 수'); range('minimum', 'maximum', '값');
    if (node.type === 'string' && typeof node.maxLength !== 'number') errors.push(fail(at, '문자열 maxLength가 필요합니다.'));
    if (node.type === 'array' && (!node.items || typeof node.maxItems !== 'number')) errors.push(fail(at, '배열에는 items와 maxItems가 필요합니다.'));
    if (node.type === 'array' && node.uniqueItems === true) {
      // 참조를 끝까지 풀어 스칼라 형식인지 본다(객체·배열·판별자 분기의 깊은 비교 비용을 막는다).
      let items = node.items;
      for (let hops = 0; typeof items?.$ref === 'string' && hops < 64; hops++) items = resolve(items);
      if (!items || Array.isArray(items.oneOf) || !SCALAR_TYPES.has(items.type)) errors.push(fail(`${at}/uniqueItems`, 'uniqueItems는 스칼라 배열에만 쓸 수 있습니다.'));
    }
    if (node.type === 'object') {
      if (node.additionalProperties !== false || !node.properties || !Object.keys(node.properties).length) errors.push(fail(at, '객체에는 properties와 additionalProperties: false가 필요합니다.'));
      for (const name of node.required ?? []) if (!Object.hasOwn(node.properties ?? {}, name)) errors.push(fail(at, `선언하지 않은 키 ${name}을 required에 두었습니다.`));
    }
    for (const value of node.enum ?? []) if (typeof value !== (node.type === 'integer' ? 'number' : node.type)) errors.push(fail(at, 'enum 값의 형식이 type과 다릅니다.'));
    if (node['x-clack-asset']) {
      assetPointers.push(at);
      if (node.type !== 'string' || node.format !== 'uuid' || node.maxLength !== 36 || node.enum) errors.push(fail(at, '자산 노드는 {type:string, format:uuid, maxLength:36}이어야 합니다.'));
      if (info.visibility === 'private') errors.push(fail(at, '비공개 키에는 자산을 둘 수 없습니다.'));
    } else if (node.format === 'uuid' && node.type !== 'string') errors.push(fail(at, 'format은 문자열에만 씁니다.'));
    if (node['x-clack-ai']?.suggest === true) {
      if (info.visibility !== 'public') errors.push(fail(at, 'AI 제안은 공개 키에만 켤 수 있습니다.'));
      suggestRoots.push(at);
    }
  });
  if (properties > OUTPUT_DATA_LIMITS.properties) errors.push(fail('/', '데이터 스키마 속성은 400개 이하이어야 합니다.'));
  // AI 제안 대상 하위 트리에는 자산 노드를 두지 않는다(출력 스키마 파생을 단순하게 유지, 계약 §4-6).
  for (const root of suggestRoots) if (assetPointers.some((asset) => asset === root || asset.startsWith(`${root}/`))) errors.push(fail(root, 'AI 제안 하위 트리에 자산 노드를 둘 수 없습니다.'));
  return errors;
}

// 공개 데이터 문자열의 금지 문자(계약 §4-3 R2): 제어 Cc(탭·줄바꿈 제외)·서식 Cf·사설 영역 Co·짝 없는 서로게이트 Cs.
// 보이지 않는 문자로 공개 확인 시트를 속이거나 은닉 채널을 만드는 것을 막는다. 예외는 이모지 ZWJ 시퀀스 안의 U+200D 하나뿐이다
// (앞 글자가 그림 문자·VS16·피부색 수정자이고 뒤 글자가 그림 문자일 때). 서버(패치·패키징)·센터 호스트·CLI가 같은 판정을 한다.
const FORBIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/u;
const ZWJ_BEFORE = /[\p{Extended_Pictographic}\u{FE0F}\p{Emoji_Modifier}]/u;
const ZWJ_AFTER = /\p{Extended_Pictographic}/u;
function hasForbiddenCharacter(text) {
  const chars = Array.from(text);
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    if (char === '\t' || char === '\n' || !FORBIDDEN_CHARACTER.test(char)) continue;
    if (char === '‍' && index > 0 && ZWJ_BEFORE.test(chars[index - 1]) && ZWJ_AFTER.test(chars[index + 1] ?? '')) continue;
    return true;
  }
  return false;
}
/** 값(공개 데이터)의 문자열 잎 중 금지 문자가 있는 JSON Pointer 목록. 호출자가 비공개 루트 키를 먼저 뺀다. */
export function inspectPublicDataStrings(value) {
  const paths = [];
  const escape = (key) => key.replace(/~/g, '~0').replace(/\//g, '~1');
  const walk = (node, pointer) => {
    if (typeof node === 'string') { if (hasForbiddenCharacter(node)) paths.push(pointer); return; }
    if (Array.isArray(node)) { node.forEach((item, index) => walk(item, `${pointer}/${index}`)); return; }
    if (node && typeof node === 'object') for (const [key, child] of Object.entries(node)) walk(child, `${pointer}/${escape(key)}`);
  };
  walk(value, '');
  return paths;
}

