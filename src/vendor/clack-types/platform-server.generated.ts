/** 모노레포 clack-types/platform.generated.ts에서 CLI(src/commands/platform.ts)가 실제로 쓰는 서버 키 데이터 연산
 * (getServerUsage, getServerDocument, putServerDocument, patchServerDocument, deleteServerDocument, listServerDocuments, getServerLeaderboard)과 그 참조 타입만 scripts/sync-vendor-types.mjs로 추출한
 * 부분집합이다. 원본에는 관리자·런타임 연산까지 포함된 전체 API 표면이 있으나 이 파일에는
 * 포함하지 않는다. 이 파일을 직접 수정하지 말고 `scripts/sync-vendor-types.mjs`로 갱신한다. */
// 원본 안내: 공개 JSON Schema와 OpenAPI에서 자동 생성합니다. 직접 수정하지 마세요.
// 조건부 제약·문자열 패턴·수치 범위는 런타임 스키마 검증이 최종 기준입니다.

export type PlatformApiDocument = { "collection": string; "key": string; "owner": string; "rev": number; "body": Record<string, unknown>; "created_at": string; "updated_at": string; };
export type PlatformApiLeaderboard = { "field": string; "entries": Array<{ "rank": number; "key": string; "owner": string; "value": number; "body"?: Record<string, unknown>; }>; "me": ({ "rank": number; "value": number; }) | (null); };

export interface PlatformApiOperations {
  "getServerUsage": {
    method: "GET"; path: "/platform/v1/usage";
    pathParams: {  }; query: { "from"?: string; "to"?: string; }; headers: {  };
    body: null; response: { "data": { "from": string; "to": string; "usage": Record<string, unknown>; }; };
  };
  "getServerDocument": {
    method: "GET"; path: "/platform/v1/data/{col}/docs/{key}";
    pathParams: { "col": string; "key": string; }; query: { "viewer_id"?: string; }; headers: {  };
    body: null; response: { "data": PlatformApiDocument; };
  };
  "putServerDocument": {
    method: "PUT"; path: "/platform/v1/data/{col}/docs/{key}";
    pathParams: { "col": string; "key": string; }; query: { "viewer_id"?: string; }; headers: { "If-Match"?: string; "If-None-Match"?: "*"; };
    body: { "body": Record<string, unknown>; }; response: { "data": PlatformApiDocument; };
  };
  "patchServerDocument": {
    method: "PATCH"; path: "/platform/v1/data/{col}/docs/{key}";
    pathParams: { "col": string; "key": string; }; query: { "viewer_id"?: string; }; headers: { "If-Match"?: string; };
    body: { "patch": Record<string, unknown>; }; response: { "data": PlatformApiDocument; };
  };
  "deleteServerDocument": {
    method: "DELETE"; path: "/platform/v1/data/{col}/docs/{key}";
    pathParams: { "col": string; "key": string; }; query: { "viewer_id"?: string; }; headers: {  };
    body: null; response: null;
  };
  "listServerDocuments": {
    method: "GET"; path: "/platform/v1/data/{col}/docs";
    pathParams: { "col": string; }; query: { "viewer_id"?: string; "owner"?: "me" | "any"; "order"?: "updated_desc" | "sort_desc" | "sort_asc"; "cursor"?: string; "limit"?: number; }; headers: {  };
    body: null; response: { "data": Array<PlatformApiDocument>; "pagination": { "next_cursor": (string) | (null); "has_more": boolean; }; };
  };
  "getServerLeaderboard": {
    method: "GET"; path: "/platform/v1/data/{col}/leaderboard";
    pathParams: { "col": string; }; query: { "viewer_id"?: string; "limit"?: number; }; headers: {  };
    body: null; response: { "data": PlatformApiLeaderboard; };
  };
}
