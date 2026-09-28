/** 모노레포 clack-api-v4/contracts/platform/authoring-semantics.d.mts에서 복사한 파일이다. 이 파일을 직접 수정하지 말고
 * `scripts/sync-vendor-types.mjs`로 갱신한다. */
/** 서버와 CLI가 공유하는 제작 필드 관계 검사. */
export function inspectAuthoringSemantics(skill: Record<string, unknown>, form?: Record<string, unknown>): Array<{ path: string; message: string }>;
