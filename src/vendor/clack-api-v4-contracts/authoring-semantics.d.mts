/** 모노레포 clack-api-v4/contracts/platform/authoring-semantics.d.mts에서 복사한 파일이다. 이 파일을 직접 수정하지 말고
 * `scripts/sync-vendor-types.mjs`로 갱신한다. */
/** 서버와 CLI가 공유하는 제작 필드 관계 검사. 에디터 스킬은 세 번째 인자로 데이터 문서 스키마를 넘긴다. */
export function inspectAuthoringSemantics(skill: Record<string, unknown>, form?: Record<string, unknown>, data?: Record<string, unknown>): Array<{ path: string; message: string }>;
/** 데이터 문서 스키마(output-data.v1)를 로컬 $ref까지 따라가며 노드를 방문한다. */
export function walkDataSchema(schema: Record<string, unknown>, visit: (node: Record<string, unknown>, info: {
  pointer: string; depth: number; root: string | null; visibility: 'public' | 'private' | null | undefined; refs: string[];
  branch: boolean; cycle?: boolean; unresolved?: boolean;
}) => void): void;
/**
 * 폼 필드 라벨: x-clack-i18n[lang] → x-clack-i18n.ko → title → fallback(문자열이 아니거나 빈 후보는 건너뛴다).
 * normalize를 주면 후보마다 적용한 뒤 빈 값을 건너뛴다(자동 구성은 NFC·앞뒤 공백 제거).
 */
export function formFieldLabel(node: unknown, fallback: string, lang?: string, options?: { normalize?: (value: string) => string }): string;
/** 직전 승인 버전 대비 비공개→공개로 바뀐 루트 키(업로드 422 SKILL_DATA_VISIBILITY_CHANGED, 업그레이드 409 DATA_VISIBILITY_CHANGED). */
export function inspectDataVisibilityChange(previous: Record<string, unknown> | null | undefined, next: Record<string, unknown>): Array<{ path: string; message: string }>;
