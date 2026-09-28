// 모노레포 clack-api-v4/contracts/platform/authoring-semantics.mjs에서 복사한 파일이다. 이 파일을 직접 수정하지 말고
// scripts/sync-vendor-types.mjs로 갱신한다.
/** 공개 제작 규격의 필드 간 관계를 서버와 CLI에서 함께 검증한다. */
export function inspectAuthoringSemantics(skill, form) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
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
