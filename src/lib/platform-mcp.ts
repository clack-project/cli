import { authoringInput, authoringRequest } from '../commands/authoring.js';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { ApiClient, VERSION, type ApiOptions } from '../core/api.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/secrets.js';
import { platformDeleteDocument, platformDocument, platformDocuments, platformLeaderboard, platformPatchDocument,
  platformPatClient, platformPutDocument, platformReadSchemas, platformServerClient, platformUsage, platformWritePreview } from '../commands/platform.js';
import { pushSkillVersion } from '../commands/skill.js';
import { prepareSkillPackage } from './skill-package.js';

const protocolVersions = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const maxLineBytes = 1024 * 1024;
type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc: '2.0'; id?: JsonRpcId; method: string; params?: unknown };
type JsonRpcResponse = { jsonrpc: '2.0'; id: JsonRpcId; result?: unknown;
  error?: { code: number; message: string } };

const collectionKey = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const patSchemas = {
  skillList: z.object({ q: z.string().trim().min(1).max(100).optional() }).strict(),
  skillGet: z.object({ slug: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/) }).strict(),
  skillPush: z.object({ dir: z.string().min(1).max(4096).optional(), skill_id: z.uuid().optional() }).strict(),
  skillVersionRef: z.object({ skill_id: z.uuid(), version_id: z.uuid() }).strict(),
  skillSubmit: z.object({ skill_id: z.uuid(), version_id: z.uuid(), confirm: z.boolean().optional() }).strict(),
  skillRelease: z.object({ skill_id: z.uuid(), version_id: z.uuid(), visibility: z.enum(['private', 'unlisted', 'public']),
    confirm: z.boolean().optional() }).strict(),
  contentPublish: z.object({ content_id: z.uuid(), version_id: z.uuid(), confirm: z.boolean().optional() }).strict(),
  sharedCollections: z.object({ content_id: z.uuid() }).strict(),
  sharedList: z.object({ content_id: z.uuid(), collection: collectionKey, limit: z.number().int().min(1).max(100).optional() }).strict(),
  sharedDocument: z.object({ content_id: z.uuid(), collection: collectionKey, key: collectionKey }).strict(),
  sharedModerate: z.object({ content_id: z.uuid(), collection: collectionKey, key: collectionKey, confirm: z.boolean().optional() }).strict(),
};
const patToolNames = new Set(['platform_authoring', 'platform_skill_list', 'platform_skill_get', 'platform_skill_push', 'platform_skill_status',
  'platform_skill_submit', 'platform_skill_release', 'platform_content_publish', 'platform_shared_collections_list',
  'platform_shared_documents_list', 'platform_shared_document_get', 'platform_shared_document_hide', 'platform_shared_document_delete']);
const patDestructiveToolNames = new Set(['platform_skill_submit', 'platform_skill_release', 'platform_content_publish',
  'platform_shared_document_hide', 'platform_shared_document_delete']);

function parsePat<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new CliError(`${label} 형식을 확인하세요.`, 'VALIDATION_ERROR');
  return parsed.data;
}

const toolDefinitions = [
  { name: 'platform_authoring', description: '공개 스킬 제작 세션·폼·자산·이미지 생성·패키징을 처리합니다. 이미지 생성에는 견적 승인 가격과 멱등성 키가 필요합니다. creator-content:write 권한이 필요합니다.', inputSchema: { type: 'object', ...z.toJSONSchema(authoringInput) }, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'platform_usage_get', description: '서버 키가 속한 콘텐츠의 플랫폼 사용량을 조회합니다.',
    inputSchema: z.toJSONSchema(platformReadSchemas.usage), annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'platform_server_data_get', description: '서버 키로 콘텐츠 데이터 문서를 조회합니다. data:read 권한이 필요합니다.',
    inputSchema: z.toJSONSchema(platformReadSchemas.get), annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'platform_server_data_list', description: '서버 키로 콘텐츠 데이터 문서 목록을 조회합니다. data:read 권한이 필요합니다.',
    inputSchema: z.toJSONSchema(platformReadSchemas.list), annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'platform_server_data_leaderboard', description: '서버 키로 공유 데이터 순위를 조회합니다. data:read 권한이 필요합니다.',
    inputSchema: z.toJSONSchema(platformReadSchemas.leaderboard), annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'platform_server_data_put', description: '서버 키로 단일 문서 전체를 저장합니다. 개정 번호 또는 부재 조건과 confirm:true가 필요합니다.',
    inputSchema: z.toJSONSchema(platformReadSchemas.put), annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'platform_server_data_patch', description: '서버 키로 단일 문서를 병합 수정합니다. 개정 번호와 confirm:true가 필요합니다.',
    inputSchema: z.toJSONSchema(platformReadSchemas.patch), annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'platform_server_data_delete', description: '서버 키로 단일 문서를 삭제하거나 숨깁니다. confirm:true가 필요합니다.',
    inputSchema: z.toJSONSchema(platformReadSchemas.delete), annotations: { readOnlyHint: false, destructiveHint: true } },
  // 아래는 개인 액세스 토큰(CLACK_TOKEN, pat_)으로 동작하는 개인 도구다. 서버 키 도구와 인증 평면이 다르다.
  { name: 'platform_skill_list', description: '공개 스킬 목록을 이름으로 검색합니다. skill:read 권한이 필요합니다.',
    inputSchema: z.toJSONSchema(patSchemas.skillList), annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'platform_skill_get', description: '스킬 상세를 이름(slug)으로 조회합니다. skill:read 권한이 필요합니다.',
    inputSchema: z.toJSONSchema(patSchemas.skillGet), annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'platform_skill_push', description: '로컬 스킬 디렉터리를 검증하고 새 버전으로 업로드합니다. dir을 생략하면 현재 디렉터리를 사용합니다. skill:write 권한이 필요합니다.',
    inputSchema: z.toJSONSchema(patSchemas.skillPush), annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'platform_skill_status', description: '내 스킬 버전의 심사·게시 상태를 조회합니다. skill:read 권한이 필요합니다.',
    inputSchema: z.toJSONSchema(patSchemas.skillVersionRef), annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'platform_skill_submit', description: '검증 완료한 스킬 버전을 심사에 제출합니다. skill:write와 skill:publish 권한(둘 다)과 confirm:true가 필요합니다.',
    inputSchema: z.toJSONSchema(patSchemas.skillSubmit), annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'platform_skill_release', description: '승인된 스킬 버전을 공개 범위로 게시합니다. skill:publish 권한과 confirm:true가 필요합니다.',
    inputSchema: z.toJSONSchema(patSchemas.skillRelease), annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'platform_content_publish', description: '승인된 내 HTML 콘텐츠 버전을 공개합니다. creator-content:publish 권한과 confirm:true가 필요합니다.',
    inputSchema: z.toJSONSchema(patSchemas.contentPublish), annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'platform_shared_collections_list', description: '내 콘텐츠의 이용자 공개(shared) 문서 컬렉션 이름을 조회합니다. platform:read 권한이 필요합니다.',
    inputSchema: z.toJSONSchema(patSchemas.sharedCollections), annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'platform_shared_documents_list', description: '내 콘텐츠의 공유 문서 목록을 조회합니다. platform:read 권한이 필요합니다.',
    inputSchema: z.toJSONSchema(patSchemas.sharedList), annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'platform_shared_document_get', description: '내 콘텐츠의 공유 문서 하나를 조회합니다. platform:read 권한이 필요합니다.',
    inputSchema: z.toJSONSchema(patSchemas.sharedDocument), annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'platform_shared_document_hide', description: '이용자가 쓴 공유 문서를 숨깁니다. platform:write 권한과 confirm:true가 필요합니다.',
    inputSchema: z.toJSONSchema(patSchemas.sharedModerate), annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'platform_shared_document_delete', description: '이용자가 쓴 공유 문서를 영구 삭제합니다. platform:write 권한과 confirm:true가 필요합니다.',
    inputSchema: z.toJSONSchema(patSchemas.sharedModerate), annotations: { readOnlyHint: false, destructiveHint: true } },
] as const;

function error(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toolResult(value: unknown, isError = false) {
  const safe = redact(value);
  return { content: [{ type: 'text', text: JSON.stringify(safe) }],
    ...(isError ? { isError: true } : { structuredContent: safe }) };
}

export class PlatformMcpServer {
  private initialized = false;

  constructor(private readonly settings: ApiOptions, private readonly env: NodeJS.ProcessEnv = process.env) {}

  async handle(message: unknown): Promise<JsonRpcResponse | undefined> {
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
      || message.id !== undefined && typeof message.id !== 'string' && typeof message.id !== 'number' && message.id !== null) {
      return error(null, -32600, '올바른 JSON-RPC 요청이 아닙니다.');
    }
    const request = message as JsonRpcRequest;
    if (request.id === undefined) {
      if (request.method === 'notifications/initialized') this.initialized = true;
      return undefined;
    }
    if (request.method === 'initialize') {
      const requested = isObject(request.params) && typeof request.params.protocolVersion === 'string'
        ? request.params.protocolVersion : '';
      if (!requested) return error(request.id, -32602, '프로토콜 버전이 필요합니다.');
      this.initialized = false;
      return { jsonrpc: '2.0', id: request.id, result: {
        protocolVersion: protocolVersions.has(requested) ? requested : '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'clack-platform-cli', version: VERSION },
      } };
    }
    if (request.method === 'ping') return { jsonrpc: '2.0', id: request.id, result: {} };
    if (!this.initialized) return error(request.id, -32000, 'MCP 초기화가 필요합니다.');
    if (request.method === 'tools/list') return { jsonrpc: '2.0', id: request.id, result: { tools: toolDefinitions } };
    if (request.method !== 'tools/call') return error(request.id, -32601, '지원하지 않는 MCP 메서드입니다.');
    if (!isObject(request.params) || typeof request.params.name !== 'string'
      || request.params.arguments !== undefined && !isObject(request.params.arguments)) {
      return error(request.id, -32602, '도구 이름과 인자를 확인하세요.');
    }
    const name = request.params.name;
    if (!toolDefinitions.some((tool) => tool.name === name)) return error(request.id, -32602, '등록되지 않은 도구입니다.');
    try {
      const args = request.params.arguments ?? {};
      const writeKind = name === 'platform_server_data_put' ? 'put'
        : name === 'platform_server_data_patch' ? 'patch'
          : name === 'platform_server_data_delete' ? 'delete' : null;
      if (writeKind) {
        const preview = platformWritePreview(writeKind, args);
        if (!isObject(args) || args.confirm !== true) {
          return { jsonrpc: '2.0', id: request.id, result: toolResult({ preview: true, confirmation_required: true, ...preview }) };
        }
      }
      if (patToolNames.has(name)) {
        const result = await this.callPatTool(name, args);
        return { jsonrpc: '2.0', id: request.id, result: toolResult(result) };
      }
      const client = platformServerClient(this.settings, this.env);
      const result = name === 'platform_usage_get' ? await platformUsage(client, args)
        : name === 'platform_server_data_get' ? await platformDocument(client, args)
          : name === 'platform_server_data_list' ? await platformDocuments(client, args)
            : name === 'platform_server_data_leaderboard' ? await platformLeaderboard(client, args)
              : name === 'platform_server_data_put' ? await platformPutDocument(client, args)
                : name === 'platform_server_data_patch' ? await platformPatchDocument(client, args)
                  : await platformDeleteDocument(client, args);
      return { jsonrpc: '2.0', id: request.id, result: toolResult(result) };
    } catch (cause) {
      const failure = cause instanceof CliError ? `[${cause.code}] ${cause.message}` : '[INTERNAL_ERROR] 요청을 처리하지 못했습니다.';
      return { jsonrpc: '2.0', id: request.id, result: toolResult({ error: failure }, true) };
    }
  }

  /** 개인 액세스 토큰(platform:read·platform:write, skill:*, creator-content:write·publish 스코프) 기반 도구. */
  private async callPatTool(name: string, args: unknown): Promise<unknown> {
    if (patDestructiveToolNames.has(name) && (!isObject(args) || args.confirm !== true)) {
      return { preview: true, confirmation_required: true, tool: name, arguments: redact(args) };
    }
    const client = platformPatClient(this.settings, this.env);
    if (name === 'platform_authoring') return authoringRequest(client, args, 'mcp');
    if (name === 'platform_skill_list') {
      const { q } = parsePat(patSchemas.skillList, args, '스킬 목록 조회 입력');
      return client.request('GET', '/v4/skills', { query: { q } });
    }
    if (name === 'platform_skill_get') {
      const { slug } = parsePat(patSchemas.skillGet, args, '스킬 조회 입력');
      return client.request('GET', `/v4/skills/${slug}`);
    }
    if (name === 'platform_skill_push') {
      const { dir, skill_id } = parsePat(patSchemas.skillPush, args, '스킬 업로드 입력');
      const prepared = await prepareSkillPackage(dir ?? '.', { fillEditorHash: true });
      if (prepared.manifest.type !== 'instruction' && prepared.manifest.type !== 'template') {
        throw new CliError('현재 스킬 업로드는 instruction·template 유형만 지원합니다.', 'SKILL_TYPE_UNSUPPORTED');
      }
      return pushSkillVersion(client, prepared, skill_id);
    }
    if (name === 'platform_skill_status') {
      const { skill_id, version_id } = parsePat(patSchemas.skillVersionRef, args, '스킬 버전 조회 입력');
      return client.request('GET', `/v4/creator/skills/${skill_id}/versions/${version_id}`);
    }
    if (name === 'platform_skill_submit') {
      const { skill_id, version_id } = parsePat(patSchemas.skillSubmit, args, '스킬 심사 제출 입력');
      return client.request('POST', `/v4/creator/skills/${skill_id}/versions/${version_id}/submit`);
    }
    if (name === 'platform_skill_release') {
      const { skill_id, version_id, visibility } = parsePat(patSchemas.skillRelease, args, '스킬 공개 입력');
      return client.request('POST', `/v4/creator/skills/${skill_id}/versions/${version_id}/release`, { body: { visibility } });
    }
    if (name === 'platform_content_publish') {
      const { content_id, version_id } = parsePat(patSchemas.contentPublish, args, '콘텐츠 공개 입력');
      return client.request('POST', `/v4/creator/contents/${content_id}/versions/${version_id}/publish`);
    }
    if (name === 'platform_shared_collections_list') {
      const { content_id } = parsePat(patSchemas.sharedCollections, args, '공유 문서 컬렉션 조회 입력');
      return client.request('GET', `/v4/creator/contents/${content_id}/shared-document-collections`);
    }
    if (name === 'platform_shared_documents_list') {
      const { content_id, collection, limit } = parsePat(patSchemas.sharedList, args, '공유 문서 목록 조회 입력');
      return client.request('GET', `/v4/creator/contents/${content_id}/shared-documents/${collection}`, { query: { limit } });
    }
    if (name === 'platform_shared_document_get') {
      const { content_id, collection, key } = parsePat(patSchemas.sharedDocument, args, '공유 문서 조회 입력');
      return client.request('GET', `/v4/creator/contents/${content_id}/shared-documents/${collection}/${key}`);
    }
    if (name === 'platform_shared_document_hide') {
      const { content_id, collection, key } = parsePat(patSchemas.sharedModerate, args, '공유 문서 숨김 입력');
      return client.request('POST', `/v4/creator/contents/${content_id}/shared-documents/${collection}/${key}/hide`);
    }
    const { content_id, collection, key } = parsePat(patSchemas.sharedModerate, args, '공유 문서 삭제 입력');
    return client.request('DELETE', `/v4/creator/contents/${content_id}/shared-documents/${collection}/${key}`);
  }
}

/** MCP stdio는 UTF-8 JSON-RPC 한 줄을 한 메시지로 주고받는다. stdout에는 프로토콜 메시지만 쓴다. */
export async function servePlatformMcp(settings: ApiOptions, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const server = new PlatformMcpServer(settings, env);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let response: JsonRpcResponse | undefined;
    if (Buffer.byteLength(line, 'utf8') > maxLineBytes) response = error(null, -32600, 'MCP 요청 크기 제한을 초과했습니다.');
    else {
      let value: unknown;
      try { value = JSON.parse(line); }
      catch { response = error(null, -32700, 'JSON을 읽을 수 없습니다.'); }
      if (response === undefined) response = await server.handle(value);
    }
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  }
}
