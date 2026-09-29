// 모노레포 clack-api-v4/contracts/platform/authoring-semantics.mjs에서 복사한 파일이다. 이 파일을 직접 수정하지 말고
// scripts/sync-vendor-types.mjs로 갱신한다.
/**
 * 데이터 문서 스키마(output-data.v1)를 로컬 `$ref`까지 따라가며 노드마다 `visit(node, info)`를 부른다.
 * `info`는 `{ pointer, depth, root, visibility, refs }`이며 순환 참조는 따라가지 않고 `info.cycle`로 알린다.
 * 서버(스킬 업로드)·CLI(validate)·validators.mjs가 같은 순회 규칙을 쓴다.
 */
export function walkDataSchema(schema, visit) {
  const defs = schema?.$defs ?? {};
  const step = (node, info) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (typeof node.$ref === 'string') {
      const key = node.$ref.startsWith('#/$defs/') ? node.$ref.slice('#/$defs/'.length) : null;
      if (key === null || !Object.hasOwn(defs, key) || info.refs.includes(key)) { visit(node, { ...info, cycle: key !== null && info.refs.includes(key), unresolved: key === null || !Object.hasOwn(defs, key) }); return; }
      visit(node, info);
      step(defs[key], { ...info, refs: [...info.refs, key] });
      return;
    }
    visit(node, info);
    for (const branch of Array.isArray(node.oneOf) ? node.oneOf : []) step(branch, { ...info, branch: true });
    for (const [name, child] of Object.entries(node.properties && typeof node.properties === 'object' ? node.properties : {})) {
      step(child, { ...info, pointer: `${info.pointer}/${name}`, depth: info.depth + 1, root: info.depth === 0 ? name : info.root,
        visibility: info.depth === 0 ? child?.['x-clack-visibility'] : info.visibility, branch: false });
    }
    if (node.items && typeof node.items === 'object') step(node.items, { ...info, pointer: `${info.pointer}/*`, depth: info.depth + 1, branch: false });
  };
  step(schema, { pointer: '', depth: 0, root: null, visibility: null, refs: [], branch: false });
}

/** 루트 필드를 `$ref` 한 단계까지 풀어 돌려준다(메타데이터 참조 검사용). */
function dataRootField(schema, name) {
  const field = schema?.properties?.[name];
  if (!field || typeof field !== 'object') return null;
  if (typeof field.$ref === 'string' && field.$ref.startsWith('#/$defs/')) {
    const target = schema.$defs?.[field.$ref.slice('#/$defs/'.length)];
    return target && typeof target === 'object' ? { ...target, 'x-clack-visibility': field['x-clack-visibility'] } : null;
  }
  return field;
}

/** 스킬 에디터(`authoring.editor`) 선언의 필드 간 관계. `data`는 output.data.schema 파일을 파싱한 객체다(없으면 선언만 본다). */
function inspectEditorSemantics(skill, data, fail) {
  const editor = skill.authoring?.editor;
  if (!editor) return;
  const permissions = new Set(editor.permissions ?? []);
  if (!permissions.has('document.read') || !permissions.has('document.write')) fail('/authoring/editor/permissions', '에디터에는 document.read와 document.write 권한이 모두 필요합니다.');
  if (permissions.has('ai.suggest') && skill.authoring?.ai_fill?.enabled !== true) fail('/authoring/editor/permissions', 'ai.suggest 권한에는 authoring.ai_fill.enabled가 필요합니다.');
  const imageTool = (skill.authoring?.tools ?? []).find((tool) => tool.tool === 'image.generate');
  if (permissions.has('tools.image.generate') && !imageTool) fail('/authoring/editor/permissions', 'tools.image.generate 권한에는 authoring.tools의 image.generate 선언이 필요합니다.');
  if (imageTool?.aspect === 'slot') fail('/authoring/tools', '에디터 스킬은 슬롯 비율(aspect: slot)을 쓸 수 없습니다. 자산 노드의 x-clack-asset.aspect를 쓰세요.');
  if (!data) return;
  let assets = 0;
  let suggest = 0;
  walkDataSchema(data, (node) => {
    if (node['x-clack-asset']) assets++;
    if (node['x-clack-ai']?.suggest === true) suggest++;
  });
  if (assets > 0 && !skill.output?.data?.assets) fail('/output/data/assets', '자산 노드가 있는 데이터 스키마에는 output.data.assets 한도가 필요합니다.');
  if (assets === 0 && skill.output?.data?.assets) fail('/output/data/assets', '자산 노드가 없는데 자산 한도를 선언했습니다.');
  if (assets === 0 && permissions.has('tools.image.generate')) fail('/authoring/editor/permissions', '이미지를 넣을 자산 노드가 없습니다.');
  if (suggest === 0 && permissions.has('ai.suggest')) fail('/authoring/editor/permissions', 'x-clack-ai.suggest가 켜진 노드가 없습니다.');
  const metadata = skill.output?.metadata ?? {};
  for (const key of ['title', 'description']) {
    if (metadata[key] === undefined) continue;
    const field = dataRootField(data, metadata[key]);
    if (!field || field.type !== 'string' || field['x-clack-asset'] || field['x-clack-visibility'] !== 'public') fail(`/output/metadata/${key}`, '공개 문자열 루트 키를 가리켜야 합니다.');
  }
  for (const key of ['thumbnail', 'thumbnail_fallback']) {
    if (metadata[key] === undefined) continue;
    const field = dataRootField(data, metadata[key]);
    if (!field || !field['x-clack-asset'] || field['x-clack-visibility'] !== 'public') fail(`/output/metadata/${key}`, '공개 자산 루트 키를 가리켜야 합니다(인덱스 표기 불가).');
  }
}

/** 콘텐츠 인트로 한도(인트로 계획 _plans/creator-content-intro-plan.md §3.2·§3.9, U2·U3). 서버 `src/lib/creator-content-intro.ts`와 같은 값이다. */
const INTRO_MAX_IMAGES = 8;
const INTRO_CREATOR_COMMENT_MAX = 500;
const INTRO_DESCRIPTION_MAX = 5000;
/** 인트로 문구로 쓸 수 있는 자유 입력 위젯. 이미지(uuid)·가져오기(content_ref)·선택형 문자열은 쓰지 않는다. */
const INTRO_TEXT_WIDGETS = new Set(['text', 'textarea']);

/** 자동 구성 라벨(폼 필드 title, 없으면 필드 이름). 서버 `src/lib/skill-intro.ts`의 `skillIntroFieldLabel`과 같은 규칙이다. */
function introFieldLabel(name, field) {
  const title = typeof field?.title === 'string' ? field.title.normalize('NFC').trim() : '';
  return title || name;
}

/**
 * 콘텐츠 인트로 출력 선언(`output.intro`, 인트로 계획 §3.9)의 필드 관계.
 * - images: `output.asset_slots`의 field만. 단일 슬롯은 1장, multiple은 max장으로 세어 합계 8 이하(폼 없이도 검사한다).
 * - creator_comment·description: 공개(`x-clack-visibility: public`) 자유 입력 문자열 필드, 최대 길이 500·5000 이하.
 * - description_fallback: 자유 입력 문자열 필드만(공개 범위 무관 — 비공개 설정을 공개하는 유일한 명시 예외).
 *   자동 구성 최대 길이(필드마다 라벨+줄바꿈+최대 길이, 항목 사이 빈 줄)가 5000자를 넘으면 거부한다.
 */
function inspectIntroSemantics(skill, form, slots, fail) {
  const intro = skill.output?.intro;
  if (!intro) return;
  let images = 0;
  for (const name of intro.images ?? []) {
    const slot = slots.find((entry) => entry.field === name);
    if (!slot) { fail('/output/intro/images', '인트로 이미지는 output.asset_slots의 필드만 쓸 수 있습니다.'); continue; }
    images += slot.multiple ? slot.multiple.max : 1;
  }
  if (images > INTRO_MAX_IMAGES) fail('/output/intro/images', `인트로 이미지는 슬롯 최대 장수 합계가 ${INTRO_MAX_IMAGES}장 이하여야 합니다.`);
  if (!form) return;
  const properties = form.properties ?? {};
  const textField = (name) => {
    const field = Object.hasOwn(properties, name) ? properties[name] : null;
    return field && field.type === 'string' && INTRO_TEXT_WIDGETS.has(field['x-clack-widget']) && Number.isSafeInteger(field.maxLength) ? field : null;
  };
  for (const [key, max] of [['creator_comment', INTRO_CREATOR_COMMENT_MAX], ['description', INTRO_DESCRIPTION_MAX]]) {
    if (intro[key] === undefined) continue;
    const field = textField(intro[key]);
    if (!field || field['x-clack-visibility'] !== 'public') fail(`/output/intro/${key}`, '공개 문자열(text·textarea) 폼 필드를 가리켜야 합니다.');
    else if (field.maxLength > max) fail(`/output/intro/${key}`, `가리키는 폼 필드의 최대 길이가 ${max}자 이하여야 합니다.`);
  }
  const fallback = intro.description_fallback ?? [];
  let composed = 0;
  for (const name of fallback) {
    const field = textField(name);
    if (!field) { fail('/output/intro/description_fallback', '문자열(text·textarea) 폼 필드만 자동 구성에 쓸 수 있습니다.'); continue; }
    composed += introFieldLabel(name, field).length + 1 + field.maxLength;
  }
  composed += Math.max(0, fallback.length - 1) * 2;
  if (composed > INTRO_DESCRIPTION_MAX) fail('/output/intro/description_fallback', `자동 구성 최대 길이(라벨 포함)가 ${INTRO_DESCRIPTION_MAX}자를 넘습니다.`);
}

/**
 * 공개 제작 규격의 필드 간 관계를 서버와 CLI에서 함께 검증한다.
 * 에디터 스킬은 `form` 대신 `data`(output.data.schema를 파싱한 객체)를 세 번째 인자로 넘긴다.
 */
export function inspectAuthoringSemantics(skill, form, data) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  inspectEditorSemantics(skill, data, fail);
  const tools = skill.authoring?.tools ?? [];
  if (new Set(tools.map((tool) => tool.tool)).size !== tools.length) fail('/authoring/tools', '도구 이름을 중복 선언할 수 없습니다.');
  for (const tool of tools) if (tool.batch_max > tool.max_calls) fail('/authoring/tools', '일괄 생성 수는 세션 호출 수를 넘을 수 없습니다.');
  const slots = skill.output?.asset_slots ?? [];
  const paths = new Set();
  const fields = new Set();
  for (const slot of slots) {
    if (fields.has(slot.field)) fail('/output/asset_slots', '슬롯 필드는 중복할 수 없습니다.');
    fields.add(slot.field);
    if (slot.multiple && slot.multiple.min > slot.multiple.max) fail('/output/asset_slots', '다중 슬롯 최소 수는 최대 수보다 클 수 없습니다.');
    for (let index = 0; index < (slot.multiple?.max ?? 1); index++) {
      const path = slot.multiple ? slot.multiple.path.replace('{n}', String(index)) : slot.path;
      if (paths.has(path)) fail('/output/asset_slots', '슬롯 파일 경로는 중복할 수 없습니다.');
      paths.add(path);
    }
  }
  inspectIntroSemantics(skill, form, slots, fail);
  if (!form) return errors;
  const properties = form.properties ?? {};
  const exists = (expression, path) => {
    const match = /^([a-z][a-z0-9_-]*)(?:\[(\d+)\])?$/.exec(expression);
    if (!match || !Object.hasOwn(properties, match[1])) { fail(path, '선언한 폼 필드가 없습니다.'); return; }
    if (match[2] !== undefined) {
      const slot = slots.find((value) => value.field === match[1]);
      if (!slot?.multiple || Number(match[2]) >= slot.multiple.max) fail(path, '다중 이미지 슬롯의 유효한 인덱스가 필요합니다.');
    }
  };
  const entity = skill.output?.entity_map;
  if (entity) {
    for (const key of ['name', 'summary', 'portrait']) if (entity[key]) exists(entity[key], `/output/entity_map/${key}`);
    for (const name of entity.exports ?? []) exists(name, '/output/entity_map/exports');
  }
  for (const slot of slots) {
    const node = properties[slot.field];
    if (!node || node['x-clack-widget'] !== (slot.multiple ? 'image_list' : 'image')) fail('/output/asset_slots', '슬롯과 이미지 위젯 종류가 일치해야 합니다.');
  }
  for (const [name, node] of Object.entries(properties)) {
    if (node['x-clack-widget'] === 'content_ref') {
      if (node.type !== 'string' || !node['x-clack-source']) fail(`/properties/${name}`, 'content_ref에는 문자열과 x-clack-source 선언이 필요합니다.');
      for (const target of Object.keys(node['x-clack-source']?.import ?? {})) {
        exists(target, `/properties/${name}/x-clack-source/import`);
        if (properties[target]?.['x-clack-widget'] === 'content_ref') fail(`/properties/${name}`, '다른 content_ref 필드로 가져올 수 없습니다.');
      }
    } else if (node['x-clack-source']) fail(`/properties/${name}`, 'x-clack-source는 content_ref에만 선언합니다.');
    if (node['x-clack-widget'] === 'image_list' && (node.type !== 'array' || node.items?.type !== 'object' || !node['x-clack-asset'])) fail(`/properties/${name}`, 'image_list에는 객체 배열과 자산 선언이 필요합니다.');
  }
  return errors;
}

/**
 * 직전 승인 버전 대비 데이터 스키마 공개 범위 변경 검사(계약 §2-5·§4-10). 이전에 비공개(`private`)였던 루트 키가
 * 새 버전에서 공개(`public`)가 되면 오류다. 업로드는 422 `SKILL_DATA_VISIBILITY_CHANGED`, 업그레이드는
 * 스냅샷에 값이 있는 키에 한해 409 `DATA_VISIBILITY_CHANGED`로 쓴다. 공개→비공개 전환과 키 추가·삭제는 여기서 막지 않는다.
 */
export function inspectDataVisibilityChange(previous, next) {
  const errors = [];
  for (const [key, field] of Object.entries(previous?.properties ?? {})) {
    if (field?.['x-clack-visibility'] !== 'private') continue;
    if (next?.properties?.[key]?.['x-clack-visibility'] === 'public') {
      errors.push({ path: `/properties/${key}`, message: `비공개였던 ${key} 키를 공개로 바꿀 수 없습니다(이미 입력한 비공개 값이 공개됩니다).` });
    }
  }
  return errors;
}
