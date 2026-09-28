import type { Command } from 'commander';
import { z } from 'zod';
import { ApiClient, VERSION } from '../core/api.js';
import { apiError, CliError } from '../core/errors.js';
import type { ApiResult, Runtime } from '../core/types.js';
import { putContentFile } from './content.js';
import { prepareSkillPackage, type PreparedSkillPackage } from '../lib/skill-package.js';

const uuid = z.uuid();
const createdSchema = z.object({ id: uuid, slug: z.string(), type: z.string() });
const uploadSchema = z.object({ version_id: uuid, upload_url: z.url(), headers: z.record(z.string(), z.string()),
  expires_at: z.string(), max_upload_bytes: z.number().int().positive() });
const versionSchema = z.object({ id: uuid, skill_id: uuid, version: z.string(), review_status: z.string() });
const skillSlug = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const semver = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
const category = z.enum(['character_chat', 'quiz', 'worldbuilding', 'gallery', 'story', 'agent_tool']);
const visibility = z.enum(['private', 'unlisted', 'public']);
const managedVersionSchema = z.object({ id: uuid, skill_id: uuid, version: z.string(),
  review_status: z.string(), release_status: z.string(), package_hash: z.string().nullable() });

function serverData<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CliError('스킬 API 응답 형식이 올바르지 않습니다.', 'INVALID_RESPONSE', 502);
  return parsed.data;
}

function ensurePat(client: ApiClient, message = '스킬 업로드에는 skill:write 권한의 개인 액세스 토큰(pat_)이 필요합니다.'): string {
  const token = client.settings.token;
  if (!token || !/^pat_[a-f0-9]{64}$/.test(token)) {
    throw new CliError(message, 'SKILL_PAT_REQUIRED', 401);
  }
  return token;
}

/** JSON API와 달리 ZIP 바이트를 본문으로 보내는 읽기 전용 서버 드라이런. */
export async function validateSkillRemotely(client: ApiClient, bytes: Uint8Array): Promise<unknown> {
  const token = ensurePat(client);
  const url = new URL('/v4/creator/skills/validate', client.settings.baseUrl);
  let response: Response;
  try {
    response = await (client.settings.fetch ?? fetch)(url, { method: 'POST',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip',
        'User-Agent': `clack-cli/${VERSION}`, 'X-Platform': 'cli', 'X-App-Version': `cli/${VERSION}`,
        'x-clack-platform': 'cli', 'X-CLACK-Time-Contract': 'utc-v1', 'Cache-Control': 'no-store' },
      body: new Uint8Array(bytes), redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch { throw new CliError('스킬 사전 검증 API에 연결하지 못했습니다.', 'NETWORK_ERROR', 0); }
  let body: unknown;
  try { body = await response.json(); } catch { throw new CliError('서버가 올바른 JSON을 반환하지 않았습니다.', 'INVALID_RESPONSE', 502); }
  if (!response.ok) throw apiError(response.status, body, response.headers.get('Retry-After'));
  if (response.headers.get('X-CLACK-Time-Contract') !== 'utc-v1') {
    throw new CliError('서버 시간 계약이 일치하지 않습니다.', 'TIME_CONTRACT_MISMATCH', 0);
  }
  if (!body || typeof body !== 'object' || !('data' in body) ||
    !body.data || typeof body.data !== 'object' || !('valid' in body.data) || body.data.valid !== true) {
    throw new CliError('스킬 검증 응답 형식이 올바르지 않습니다.', 'INVALID_RESPONSE', 502);
  }
  return body.data;
}

/** 검증된 로컬 패키지를 실제 업로드한다. CLI push 명령과 로컬 플랫폼 MCP 도구가 함께 사용한다. */
export async function pushSkillVersion(client: ApiClient, prepared: PreparedSkillPackage, skillId?: string) {
  ensurePat(client);
  await validateSkillRemotely(client, prepared.bytes);
  const created = skillId ? null : serverData(createdSchema, (await client.request('POST', '/v4/creator/skills', {
    body: { slug: prepared.manifest.name, type: prepared.manifest.type },
  })).data);
  const resolvedSkillId = skillId ?? created?.id;
  if (!resolvedSkillId) throw new CliError('스킬 ID를 확인할 수 없습니다.', 'INVALID_RESPONSE', 502);
  const path = `/v4/creator/skills/${resolvedSkillId}`;
  const session = serverData(uploadSchema, (await client.request('POST', `${path}/versions`, { body: {
    version: prepared.manifest.version, sha256: prepared.sha256, byte_size: prepared.bytes.length,
  } })).data);
  if (prepared.bytes.length > session.max_upload_bytes) throw new CliError('서버 업로드 크기 제한을 초과했습니다.', 'INVALID_UPLOAD_RESPONSE', 502);
  await putContentFile({ upload_id: session.version_id, upload_url: session.upload_url, headers: session.headers }, prepared.bytes);
  try {
    const version = serverData(versionSchema, (await client.request('POST', `${path}/versions/${session.version_id}/complete`)).data);
    return { skill_id: resolvedSkillId, slug: prepared.manifest.name, version_id: version.id,
      version: version.version, review_status: version.review_status };
  } catch (error) {
    // MAJOR 강제 검증 실패는 같은 파일로 재시도해도 같으므로 완료 재시도 대신 취소 명령을 안내한다.
    if (error instanceof CliError && error.code === 'SKILL_VERSION_MAJOR_REQUIRED') {
      throw new CliError(`${error.message} (취소: clack skill cancel ${resolvedSkillId} ${session.version_id})`, error.code, error.status);
    }
    if (error instanceof CliError) throw new CliError(`${error.message} 완료 재시도: clack skill complete ${resolvedSkillId} ${session.version_id}`,
      error.code, error.status);
    throw error;
  }
}

export function registerSkillCommands(program: Command, runtime: Runtime): void {
  const skill = program.command('skill').description('스킬 패키지 검사·업로드');
  runtime.action(skill.command('list').option('-q, --query <text>', '스킬 이름 검색')
    .option('--category <category>', '분류').option('--entity <entity>', '산출물 엔티티(character)').option('--type <type>', '스킬 유형(template|instruction|tool)').option('--official <value>', '공식 스킬만 true 또는 false')
    .option('--cursor <id>', '다음 페이지 UUID').option('--all', '모든 페이지 조회'), async (ctx, _args, opts) => {
    const query = opts.query === undefined ? undefined : z.string().trim().min(1).max(100).safeParse(opts.query);
    if (query && !query.success) throw new CliError('검색어는 1~100자여야 합니다.');
    const selectedCategory = opts.category === undefined ? undefined : category.safeParse(opts.category);
    if (selectedCategory && !selectedCategory.success) throw new CliError('스킬 분류를 확인하세요.');
    if (opts.entity !== undefined && opts.entity !== 'character') throw new CliError('--entity는 character여야 합니다.');
    if (opts.type !== undefined && !['template', 'instruction', 'tool'].includes(opts.type)) throw new CliError('스킬 유형을 확인하세요.');
    if (opts.official !== undefined && !['true', 'false'].includes(opts.official)) throw new CliError('--official은 true 또는 false여야 합니다.');
    const startingCursor = opts.cursor === undefined ? undefined : uuid.safeParse(opts.cursor);
    if (startingCursor && !startingCursor.success) throw new CliError('커서는 UUID여야 합니다.');
    const seen = new Set<string>();
    const all: unknown[] = [];
    let cursor = startingCursor?.data;
    let contract: ApiResult['time_contract'] | undefined;
    while (true) {
      const result = await ctx.api.request<unknown[]>('GET', '/v4/skills', { query: {
        q: query?.data, category: selectedCategory?.data, entity: opts.entity, type: opts.type, official: opts.official,
        cursor,
      }, contract });
      if (!Array.isArray(result.data)) throw new CliError('스킬 목록 응답 형식이 올바르지 않습니다.', 'INVALID_RESPONSE', 502);
      if (!opts.all) { ctx.output(result); return; }
      contract = result.time_contract;
      all.push(...result.data);
      if (!result.pagination?.has_more) {
        ctx.output({ data: all, time_contract: result.time_contract }); return;
      }
      const next = result.pagination.next_cursor;
      if (typeof next !== 'string' || !uuid.safeParse(next).success || seen.has(next)) {
        throw new CliError('스킬 목록 커서가 누락되거나 반복되었습니다.', 'INVALID_RESPONSE', 502);
      }
      seen.add(next);
      cursor = next;
    }
  });
  runtime.action(skill.command('get <slug>'), async (ctx, [value]) => {
    const parsed = skillSlug.safeParse(value);
    if (!parsed.success) throw new CliError('스킬 이름을 확인하세요.');
    ctx.output(await ctx.api.request('GET', `/v4/skills/${parsed.data}`));
  });
  runtime.action(skill.command('form <slug> <version>'), async (ctx, [value, version]) => {
    const parsed = skillSlug.safeParse(value);
    const parsedVersion = semver.safeParse(version);
    if (!parsed.success || !parsedVersion.success) throw new CliError('스킬 이름과 버전을 확인하세요.');
    ctx.output(await ctx.api.request('GET', `/v4/skills/${parsed.data}/versions/${parsedVersion.data}/form`));
  });
  runtime.action(skill.command('status <skill-id> <version-id>'), async (ctx, [skillId, versionId]) => {
    const ids = skillVersionIds(skillId, versionId);
    ctx.output(await ctx.api.request('GET', `/v4/creator/skills/${ids.skillId}/versions/${ids.versionId}`));
  });
  runtime.action(skill.command('validate [dir]').option('--remote', '서버에서도 패키지를 드라이런 검증'), async (ctx, [dir], opts) => {
    const prepared = await prepareSkillPackage(dir ?? '.');
    if (opts.remote && !ctx.options.dryRun) {
      const remote = await validateSkillRemotely(ctx.api, prepared.bytes);
      ctx.output({ local_valid: true, sha256: prepared.sha256, byte_size: prepared.bytes.length,
        file_count: prepared.file_count, manifest: prepared.manifest, remote });
    } else ctx.output({ local_valid: true, sha256: prepared.sha256, byte_size: prepared.bytes.length,
      file_count: prepared.file_count, manifest: prepared.manifest, ...(opts.remote ? { remote_skipped: true } : {}) });
  });
  runtime.action(skill.command('push [dir]').option('--skill-id <id>', '기존 스킬 ID에 새 버전 추가'), async (ctx, [dir], opts) => {
    const prepared = await prepareSkillPackage(dir ?? '.');
    if (prepared.manifest.type !== 'instruction' && prepared.manifest.type !== 'template') {
      throw new CliError('현재 스킬 업로드는 instruction·template 유형만 지원합니다.', 'SKILL_TYPE_UNSUPPORTED');
    }
    const skillIdOption = opts.skillId === undefined ? undefined : uuid.safeParse(opts.skillId);
    if (skillIdOption && !skillIdOption.success) throw new CliError('스킬 ID는 UUID여야 합니다.');
    if (ctx.options.dryRun) {
      ctx.output({ dry_run: true, slug: prepared.manifest.name, type: prepared.manifest.type,
        version: prepared.manifest.version, sha256: prepared.sha256, byte_size: prepared.bytes.length,
        file_count: prepared.file_count, ...(skillIdOption ? { skill_id: skillIdOption.data } : {}) });
      return;
    }
    ctx.output(await pushSkillVersion(ctx.api, prepared, skillIdOption?.data));
  });
  runtime.action(skill.command('complete <skill-id> <version-id>'), async (ctx, [skillId, versionId]) => {
    ensurePat(ctx.api);
    const parsedSkillId = uuid.safeParse(skillId);
    const parsedVersionId = uuid.safeParse(versionId);
    if (!parsedSkillId.success || !parsedVersionId.success) throw new CliError('스킬·버전 ID는 UUID여야 합니다.');
    if (ctx.options.dryRun) { ctx.output({ dry_run: true, skill_id: parsedSkillId.data, version_id: parsedVersionId.data }); return; }
    ctx.output(await ctx.api.request('POST', `/v4/creator/skills/${parsedSkillId.data}/versions/${parsedVersionId.data}/complete`));
  });
  runtime.action(skill.command('submit <skill-id> <version-id>'), async (ctx, [skillId, versionId]) => {
    ensurePat(ctx.api, '스킬 심사 제출에는 skill:write와 skill:publish 권한의 개인 액세스 토큰(pat_)이 필요합니다.');
    const ids = skillVersionIds(skillId, versionId);
    const path = `/v4/creator/skills/${ids.skillId}/versions/${ids.versionId}`;
    const current = serverData(managedVersionSchema, (await ctx.api.request('GET', path)).data);
    if (current.id !== ids.versionId || current.skill_id !== ids.skillId
      || current.review_status !== 'validated' || !current.package_hash || !/^[a-f0-9]{64}$/.test(current.package_hash)) {
      throw new CliError('검증 완료 상태와 패키지 해시를 확인한 스킬 버전만 심사에 제출할 수 있습니다.', 'SKILL_NOT_VALIDATED', 409);
    }
    if (ctx.options.dryRun) {
      ctx.output({ dry_run: true, method: 'POST', path: `${path}/submit`, review_status: current.review_status,
        package_hash: current.package_hash });
      return;
    }
    await ctx.confirm(`${current.version} 버전(패키지 ${current.package_hash})을 심사에 제출할까요?`);
    ctx.output(await ctx.api.request('POST', `${path}/submit`));
  });
  runtime.action(skill.command('deprecate <skill-id>').description('스킬을 지원 종료한다 (되돌릴 수 없음, 새 설치·새 제작 불가)'), async (ctx, [skillId]) => {
    ensurePat(ctx.api);
    const parsedSkillId = uuid.safeParse(skillId);
    if (!parsedSkillId.success) throw new CliError('스킬 ID는 UUID여야 합니다.');
    const path = `/v4/creator/skills/${parsedSkillId.data}/deprecate`;
    if (ctx.options.dryRun) { ctx.output({ dry_run: true, method: 'POST', path }); return; }
    await ctx.confirm('이 스킬을 지원 종료할까요? 되돌릴 수 없으며 새 설치·새 제작이 불가능합니다(기존 콘텐츠의 고정 버전은 유지됩니다).');
    ctx.output(await ctx.api.request('POST', path));
  });
  runtime.action(skill.command('cancel <skill-id> <version-id>'), async (ctx, [skillId, versionId]) => {
    ensurePat(ctx.api);
    const ids = skillVersionIds(skillId, versionId);
    const path = `/v4/creator/skills/${ids.skillId}/versions/${ids.versionId}`;
    if (ctx.options.dryRun) { ctx.output({ dry_run: true, method: 'POST', path: `${path}/cancel` }); return; }
    await ctx.confirm('이 스킬 버전의 업로드 또는 심사를 취소할까요?');
    ctx.output(await ctx.api.request('POST', `${path}/cancel`));
  });
  runtime.action(skill.command('release <skill-id> <version-id>').requiredOption('--visibility <value>', 'private|unlisted|public'),
    async (ctx, [skillId, versionId], opts) => {
      ensurePat(ctx.api);
      const ids = skillVersionIds(skillId, versionId);
      const selected = visibility.safeParse(opts.visibility);
      if (!selected.success) throw new CliError('공개 범위는 private, unlisted, public 중 하나여야 합니다.');
      const path = `/v4/creator/skills/${ids.skillId}/versions/${ids.versionId}`;
      const current = serverData(managedVersionSchema, (await ctx.api.request('GET', path)).data);
      if (current.review_status !== 'approved' || !current.package_hash) {
        throw new CliError('승인되고 검증된 스킬 버전만 게시할 수 있습니다.', 'SKILL_NOT_APPROVED', 409);
      }
      const body = { visibility: selected.data };
      if (ctx.options.dryRun) { ctx.output({ dry_run: true, method: 'POST', path: `${path}/release`, body,
        review_status: current.review_status }); return; }
      await ctx.confirm(`${current.version} 버전을 ${selected.data} 범위로 게시할까요?`);
      ctx.output(await ctx.api.request('POST', `${path}/release`, { body }));
    });
}

function skillVersionIds(skillId: string | undefined, versionId: string | undefined) {
  const parsedSkillId = uuid.safeParse(skillId);
  const parsedVersionId = uuid.safeParse(versionId);
  if (!parsedSkillId.success || !parsedVersionId.success) throw new CliError('스킬·버전 ID는 UUID여야 합니다.');
  return { skillId: parsedSkillId.data, versionId: parsedVersionId.data };
}
