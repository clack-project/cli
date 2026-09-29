import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { CliError } from '../core/errors.js';
import { inspectAuthoringSemantics } from '../vendor/clack-api-v4-contracts/authoring-semantics.mjs';
import { inspectOutputData } from '../vendor/clack-api-v4-contracts/output-data-inspect.mjs';
import outputDataSchema from '../vendor/clack-api-v4-contracts/schemas/output-data.v1.schema.json' with { type: 'json' };

// 스킬 에디터(authoring.editor) 패키지의 로컬 검사. 구조·한도·번들 해시·데이터 스키마(output-data.v1)·예시는
// 서버와 같은 공유 계약(vendor)으로 판정하지만, 번들 코드의 구문 트리 정적 검사(editor-static-v1)는 서버에만 있다.
// 여기서는 그 일부를 문자열 수준으로만 훑어 경고로 알리고, 최종 판정은 서버가 한다.

/** 서버 PLUGIN_BUNDLE_LIMITS와 같은 값(clack-api-v4 platform-plugin-static-check.ts). */
export const EDITOR_BUNDLE_LIMITS = { maxFiles: 50, maxFileBytes: 512 * 1024, maxTotalBytes: 2 * 1024 * 1024, maxCodeBytes: 512 * 1024 } as const;
const DATA_SCHEMA_MAX_BYTES = 64 * 1024;
const ALLOWED = /\.(?:html?|js|mjs|css|json|png|jpe?g|webp|gif|woff2?)$/i;
const CODE = /\.(?:html?|js|mjs|css)$/i;
const RESERVED = /^(?:runtime|form|examples|output|data)(?:\/|$)/;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

const validateMeta = new Ajv2020({ allErrors: true, strict: false }).compile(outputDataSchema);

export type EditorSummary = {
  bundle: string; entry: string; file_count: number; total_bytes: number;
  declared_sha256: string; computed_sha256: string; hash_match: boolean;
  permissions: string[]; center_only: true;
};
export type EditorInspection = { summary: EditorSummary; warnings: string[]; computedHash: string };

const invalid = (message: string): never => { throw new CliError(message, 'SKILL_EDITOR_INVALID'); };
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');

/** 번들 파일 목록(번들 기준 상대 경로)과 해시. 서버 inspectBundle과 같은 규칙: 디렉터리는 정렬된 [{path,bytes,sha256}] JSON의 SHA-256, 단일 파일은 파일 바이트의 SHA-256. */
export function selectEditorBundle(files: Record<string, Uint8Array>, bundle: string) {
  const single = Object.hasOwn(files, bundle);
  const prefix = `${bundle}/`;
  const selected = single ? [[bundle, files[bundle]!] as const] : Object.entries(files).filter(([path]) => path.startsWith(prefix));
  const list = selected.map(([path, data]) => ({ path: single ? path.split('/').at(-1)! : path.slice(prefix.length), bytes: data.length, sha256: sha(data) }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const computed = single ? list[0]?.sha256 ?? '' : sha(JSON.stringify(list));
  return { single, selected, list, computed };
}

/** 패키지 파일에서 `authoring.editor.bundle`의 해시를 계산한다(에디터 스킬이 아니면 null). */
export function computeEditorHash(manifest: Record<string, unknown>, files: Record<string, Uint8Array>): string | null {
  const editor = (manifest.authoring as Record<string, unknown> | undefined)?.editor;
  if (!isObject(editor) || typeof editor.bundle !== 'string') return null;
  const { list, computed } = selectEditorBundle(files, editor.bundle.replace(/\/+$/, ''));
  return list.length ? computed : null;
}

function parseJson(bytes: Uint8Array, label: string): Record<string, unknown> {
  try { const value: unknown = JSON.parse(textDecoder.decode(bytes)); if (isObject(value)) return value; } catch { /* 내용은 노출하지 않는다. */ }
  return invalid(`${label}은 UTF-8 JSON 객체여야 합니다.`);
}

function scanBundle(list: ReturnType<typeof selectEditorBundle>['selected'], warnings: string[]) {
  for (const [path, data] of list) {
    if (!/\.(?:html?|js|mjs|css)$/i.test(path)) continue;
    let text: string;
    try { text = textDecoder.decode(data); } catch { invalid(`${path}는 UTF-8 텍스트여야 합니다.`); return; }
    if (/loading\s*=\s*["']?lazy/i.test(text)) warnings.push(`EDITOR_LAZY_LOAD: ${path}에 loading="lazy"가 있습니다. 에디터는 시작할 때 모든 자원을 불러와야 합니다.`);
    if (/\bimport\s*\(/.test(text)) warnings.push(`EDITOR_LAZY_LOAD: ${path}에 동적 import()가 있습니다. 정적 import만 허용됩니다.`);
    if (/\.css$/i.test(path) && /url\(\s*(?!["']?data:)/i.test(text)) {
      warnings.push(`EDITOR_CSS_URL_NOT_INLINE: ${path}의 CSS url()은 data:만 허용됩니다. 글꼴·배경 이미지는 인라인하세요.`);
    }
  }
}

/**
 * 에디터 스킬 패키지 검사. `files`는 패키지 전체(경로 → 바이트)다.
 * `hashMismatch: 'warn'`이면 선언한 sha256이 계산값과 달라도 경고로 남긴다(디렉터리 검사에서 pack이 채우기 전).
 */
export function inspectEditorSkill(manifest: Record<string, unknown>, files: Record<string, Uint8Array>,
  options: { hashMismatch: 'error' | 'warn' }): EditorInspection {
  const authoring = manifest.authoring as Record<string, unknown>;
  const output = manifest.output as Record<string, unknown>;
  const editor = authoring.editor as Record<string, unknown>;
  const warnings: string[] = [];
  const bundle = String(editor.bundle).replace(/\/+$/, '');
  if (RESERVED.test(bundle)) invalid('editor 번들 경로가 예약 경로(runtime·form·examples·output·data)입니다.');
  const { single, selected, list, computed } = selectEditorBundle(files, bundle);
  if (!list.length) invalid(`editor 번들(${bundle})에 파일이 없습니다.`);
  const entry = single ? bundle : `${bundle}/index.html`;
  if (single ? !/\.html?$/i.test(bundle) : !list.some((file) => file.path === 'index.html')) invalid(`editor 진입점(${entry})이 없습니다.`);
  if (list.length > EDITOR_BUNDLE_LIMITS.maxFiles) invalid(`editor 번들 파일 수가 ${EDITOR_BUNDLE_LIMITS.maxFiles}개를 넘습니다.`);
  const total = list.reduce((sum, file) => sum + file.bytes, 0);
  if (total > EDITOR_BUNDLE_LIMITS.maxTotalBytes) invalid('editor 번들 전체 크기가 2 MiB를 넘습니다.');
  let code = 0;
  for (const [path, data] of selected) {
    if (!ALLOWED.test(path)) invalid(`editor 번들에 허용되지 않는 파일 형식입니다: ${path}`);
    if (data.length > EDITOR_BUNDLE_LIMITS.maxFileBytes) invalid(`editor 번들 파일이 512 KiB를 넘습니다: ${path}`);
    if (CODE.test(path)) code += data.length;
  }
  if (code > EDITOR_BUNDLE_LIMITS.maxCodeBytes) invalid('editor 번들 코드(HTML·JS·CSS) 합계가 512 KiB를 넘습니다.');
  scanBundle(selected, warnings);
  const declared = String(editor.sha256);
  const match = declared === computed;
  if (!match) {
    const message = `authoring.editor.sha256이 번들 해시와 다릅니다(계산값 ${computed}). \`clack skill pack\`이 값을 채웁니다.`;
    if (options.hashMismatch === 'error') invalid(message);
    warnings.push(`PLUGIN_BUNDLE_HASH_MISMATCH: ${message}`);
  }

  const data = output.data as Record<string, unknown> | undefined;
  const schemaPath = data?.schema;
  if (typeof schemaPath !== 'string' || !files[schemaPath]) return invalid('output.data.schema 파일이 패키지에 없습니다.');
  if (files[schemaPath]!.length > DATA_SCHEMA_MAX_BYTES) invalid('데이터 스키마 파일은 64 KiB 이하여야 합니다.');
  const schema = parseJson(files[schemaPath]!, '데이터 스키마');
  if (!validateMeta(schema)) {
    invalid(`데이터 스키마가 output-data.v1과 일치하지 않습니다: ${(validateMeta.errors ?? []).slice(0, 5)
      .map((error) => `${error.instancePath || '/'} ${error.message ?? ''}`).join(' / ')}`);
  }
  const dataErrors = [...inspectOutputData(schema), ...inspectAuthoringSemantics(manifest, undefined, schema)];
  if (dataErrors.length) invalid(dataErrors.map((error) => `${error.path}: ${error.message}`).join(' / '));

  const template = output.template as Record<string, unknown> | undefined;
  if (!template || template.root !== 'runtime' || typeof template.entry !== 'string') invalid('runtime 템플릿 경로를 확인하세요.');
  if (Object.keys(files).some((path) => path.startsWith('runtime/data/'))) invalid('runtime/data/ 경로는 에디터 스킬에서 예약되어 있습니다(data/document.json과 충돌).');

  const examples = Object.keys(files).filter((path) => /^examples\/[^/]+\.json$/.test(path));
  if (!examples.length || examples.length > 10) invalid('템플릿 예시는 1~10개 필요합니다.');
  let validateExample: (value: unknown) => boolean;
  try {
    // 예시는 공개·비공개 키를 한 객체에 담은 완성 문서다. 자산 값은 임의 UUID.
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    validateExample = ajv.compile(schema);
  } catch { return invalid('데이터 스키마를 컴파일할 수 없습니다.'); }
  for (const path of examples) {
    if (files[path]!.length > 256 * 1024) invalid(`예시가 너무 큽니다: ${path}`);
    if (!validateExample(parseJson(files[path]!, '예시'))) invalid(`데이터 스키마와 예시가 일치하지 않습니다: ${path}`);
  }
  return { computedHash: computed, warnings, summary: { bundle, entry, file_count: list.length, total_bytes: total,
    declared_sha256: declared, computed_sha256: computed, hash_match: match,
    permissions: editor.permissions as string[], center_only: true } };
}
