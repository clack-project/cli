/** 모노레포 validators.mjs의 검사 구간에서 추출한 선언. scripts/sync-vendor-types.mjs가 만든다. */
export const OUTPUT_DATA_LIMITS: { schema_bytes: number; depth: number; properties: number; public_bytes: number; private_bytes: number; ui_state_bytes: number };
/** 데이터 문서 스키마(output-data.v1)의 메타 스키마로 표현할 수 없는 규칙 검사. 오류가 없으면 빈 배열. */
export function inspectOutputData(schema: Record<string, unknown>): Array<{ path: string; message: string }>;
/** 공개 데이터 문자열 잎 중 금지 문자가 있는 JSON Pointer 목록. */
export function inspectPublicDataStrings(value: unknown): string[];
