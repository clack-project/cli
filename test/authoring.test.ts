import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { ApiClient } from '../src/core/api.js';
import { authoringRequest } from '../src/commands/authoring.js';
import { prepareSkillPackage } from '../src/lib/skill-package.js';

// 실제 스킬 패키지 샘플은 모노레포(clack-api-v4/skills)에만 있다. 공개 저장소 단독 체크아웃에서는
// CLACK_MONOREPO_DIR(기본 ../clack)이 없으면 이 스위트를 건너뛴다.
const monorepoDir = resolve(process.env.CLACK_MONOREPO_DIR ?? '../clack');
const skillsFixtureDir = resolve(monorepoDir, 'clack-api-v4/skills');
const hasMonorepoFixtures = existsSync(skillsFixtureDir);

const sessionId = '00000000-0000-4000-8000-000000000001';
test('제작 이미지 배치는 승인 가격과 멱등성 키를 보존하고 중복 항목은 요청 전에 거부한다', async () => {
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const api = new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', token: `pat_${'a'.repeat(64)}`,
    fetch: (async (url, init) => {
      requests.push({ path: new URL(String(url)).pathname, init: init! });
      return new Response(JSON.stringify({ data: {} }), { headers: { 'X-CLACK-Time-Contract': 'utc-v1' } });
    }) as typeof fetch });
  const input = { action: 'image-batch', session_id: sessionId, form_revision: 3, asset_slot: 'plates',
    approved_price_cash: 60, idempotency_key: 'album-request-001', item_indexes: [0, 1] };
  await authoringRequest(api, input);
  assert.equal(requests[0]!.path, `/v4/creator/authoring-sessions/${sessionId}/tools/image.generate/batch`);
  assert.equal(new Headers(requests[0]!.init.headers).get('Idempotency-Key'), 'album-request-001');
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { form_revision: 3, asset_slot: 'plates', approved_price_cash: 60, item_indexes: [0, 1] });
  await assert.rejects(authoringRequest(api, { ...input, item_indexes: [0, 0] }));
  assert.equal(requests.length, 1);
});

test('공식 이미지·챗과 서드파티 이미지·챗을 CLI에서도 같은 규격으로 검사한다', { skip: !hasMonorepoFixtures && '모노레포 스킬 샘플 없음 — 건너뜀' }, async () => {
  for (const path of ['clack-character-chat/1.0.1', 'clack-character-chat/2.0.0', 'clack-character-image/1.0.0',
    'examples/third-party/creature-portrait', 'examples/third-party/creature-chat']) {
    const prepared = await prepareSkillPackage(resolve(skillsFixtureDir, path));
    assert.ok(prepared.bytes.length > 0);
  }
});
