import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { unzipSync } from 'fflate';
import type { CommandContext, Runtime } from '../src/core/types.js';
import { registerSkillCommands } from '../src/commands/skill.js';
import { prepareSkillPackage } from '../src/lib/skill-package.js';

const ZERO = '0'.repeat(64);
const manifest = { manifest_version: 1, name: 'my-editor', version: '1.0.0', type: 'template',
  display: { title: { ko: '내 에디터' }, summary: { ko: '한 화면 편집' }, category: 'quiz' },
  authoring: { modes: ['template'], surfaces: ['center'], editor: { bundle: 'editor', sha256: ZERO,
    permissions: ['document.read', 'document.write', 'preview'], purpose: { ko: '테스트를 편집합니다' } } },
  output: { content_kind: 'html', discovery_category: 'quiz', template: { root: 'runtime', entry: 'index.html' },
    metadata: { title: 'title' }, data: { schema: 'output/data.schema.json' } },
  runtime: { sdk_version: 1, capabilities: [], collections: {}, profiles: [], rating_max: 'all', game: 'not_game' } };
const dataSchema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, required: ['title'],
  properties: { title: { type: 'string', minLength: 1, maxLength: 60, 'x-clack-visibility': 'public' },
    memo: { type: 'string', maxLength: 200, 'x-clack-visibility': 'private' } } };

async function fixture(schema: unknown = dataSchema) {
  const temp = await mkdtemp(join(tmpdir(), 'clack-editor-'));
  const dir = join(temp, 'my-editor');
  for (const sub of ['editor', 'output', 'runtime', 'examples']) await mkdir(join(dir, sub), { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), '---\nname: my-editor\ndescription: 한 화면 에디터로 만듭니다\nmetadata:\n  version: 1.0.0\n---\n\n안내.\n');
  await writeFile(join(dir, 'clack.skill.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(dir, 'editor/index.html'), '<!doctype html><script type="module" src="editor.js"></script>');
  await writeFile(join(dir, 'editor/editor.js'), 'export const ready = true;\n');
  await writeFile(join(dir, 'output/data.schema.json'), JSON.stringify(schema));
  await writeFile(join(dir, 'runtime/index.html'), '<!doctype html><main id="app"></main>');
  await writeFile(join(dir, 'examples/basic.json'), JSON.stringify({ title: '예시', memo: '메모' }));
  return { temp, dir };
}
function runtimeFor(ctx: CommandContext): Runtime {
  return { action(command, handler) { command.action(async (...values: unknown[]) => {
    const cmd = values.at(-1) as Command;
    await handler(ctx, values.slice(0, -2) as string[], cmd.opts());
  }); } };
}

test('에디터 스킬: 디렉터리 검사는 해시 불일치를 경고로, pack이 sha256을 채운다', async () => {
  const { temp, dir } = await fixture();
  try {
    const checked = await prepareSkillPackage(dir);
    assert.equal(checked.editor?.hash_match, false);
    assert.equal(checked.editor?.center_only, true);
    assert.match(checked.warnings?.join('\n') ?? '', /PLUGIN_BUNDLE_HASH_MISMATCH/);
    const packed = await prepareSkillPackage(dir, { fillEditorHash: true });
    const files = { 'editor.js': 'export const ready = true;\n', 'index.html': '<!doctype html><script type="module" src="editor.js"></script>' };
    const expected = createHash('sha256').update(JSON.stringify(Object.entries(files).map(([path, text]) => (
      { path, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') })))).digest('hex');
    assert.equal(packed.editor?.computed_sha256, expected);
    assert.equal(packed.editor?.hash_match, true);
    const inner = JSON.parse(new TextDecoder().decode(unzipSync(packed.bytes)['clack.skill.json']!));
    assert.equal(inner.authoring.editor.sha256, expected);
    // 채운 ZIP을 다시 검사하면 오류 없이 통과하고, 원본 디렉터리는 그대로다.
    assert.equal(JSON.parse(await readFile(join(dir, 'clack.skill.json'), 'utf8')).authoring.editor.sha256, ZERO);
    const zip = join(temp, 'out.zip');
    await writeFile(zip, packed.bytes);
    assert.equal((await prepareSkillPackage(zip)).editor?.hash_match, true);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('에디터 스킬: 데이터 스키마의 pattern·객체 배열 uniqueItems·번들 규칙 위반을 거부한다', async () => {
  const withPattern = structuredClone(dataSchema) as any;
  withPattern.properties.title.pattern = '^a+$';
  let f = await fixture(withPattern);
  try { await assert.rejects(prepareSkillPackage(f.dir, { fillEditorHash: true }), /output-data\.v1/); } finally { await rm(f.temp, { recursive: true, force: true }); }

  const uniqueObjects = structuredClone(dataSchema) as any;
  uniqueObjects.properties.rows = { type: 'array', maxItems: 5, uniqueItems: true, 'x-clack-visibility': 'public',
    items: { type: 'object', additionalProperties: false, properties: { a: { type: 'string', maxLength: 5 } } } };
  f = await fixture(uniqueObjects);
  try { await assert.rejects(prepareSkillPackage(f.dir, { fillEditorHash: true }), /uniqueItems/); } finally { await rm(f.temp, { recursive: true, force: true }); }

  f = await fixture();
  try {
    await writeFile(join(f.dir, 'editor/logo.svg'), '<svg/>');
    await assert.rejects(prepareSkillPackage(f.dir, { fillEditorHash: true }), /허용되지 않는 파일 형식/);
    await rm(join(f.dir, 'editor/logo.svg'));
    await writeFile(join(f.dir, 'examples/basic.json'), JSON.stringify({ memo: '제목 없음' }));
    await assert.rejects(prepareSkillPackage(f.dir, { fillEditorHash: true }), /예시가 일치하지/);
    await writeFile(join(f.dir, 'examples/basic.json'), JSON.stringify({ title: '예시' }));
    await mkdir(join(f.dir, 'runtime/data'));
    await writeFile(join(f.dir, 'runtime/data/document.json'), '{}');
    await assert.rejects(prepareSkillPackage(f.dir, { fillEditorHash: true }), /runtime\/data/);
    await rm(join(f.dir, 'runtime/data'), { recursive: true });
    await rm(join(f.dir, 'editor/index.html'));
    await assert.rejects(prepareSkillPackage(f.dir, { fillEditorHash: true }), /진입점/);
  } finally { await rm(f.temp, { recursive: true, force: true }); }
});

test('에디터 스킬: 지연 로드 의심은 경고로만 알린다(서버 정적 검사가 최종)', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'editor/editor.js'), 'const m = () => import("./x.js");\n');
    await writeFile(join(f.dir, 'editor/editor.css'), '.a{background:url(bg.png)}');
    const prepared = await prepareSkillPackage(f.dir, { fillEditorHash: true });
    const text = prepared.warnings?.join('\n') ?? '';
    assert.match(text, /EDITOR_LAZY_LOAD/);
    assert.match(text, /EDITOR_CSS_URL_NOT_INLINE/);
  } finally { await rm(f.temp, { recursive: true, force: true }); }
});

test('skill pack은 ZIP을 쓰고 --write-manifest로 매니페스트를 갱신하며, editor dev는 SDK 경로를 해석한다', async () => {
  const f = await fixture();
  const outputs: any[] = [];
  const ctx = { options: { dryRun: false }, output: (value: unknown) => outputs.push(value), confirm: async () => undefined } as unknown as CommandContext;
  const program = new Command().exitOverride();
  registerSkillCommands(program, runtimeFor(ctx));
  try {
    const out = join(f.temp, 'my-editor.zip');
    await program.parseAsync(['node', 'clack', 'skill', 'pack', f.dir, '-o', out, '--write-manifest']);
    assert.equal(outputs[0].editor_hash_filled, true);
    assert.equal(outputs[0].manifest_written, true);
    assert.ok(existsSync(out));
    const written = JSON.parse(await readFile(join(f.dir, 'clack.skill.json'), 'utf8'));
    assert.equal(written.authoring.editor.sha256, outputs[0].editor.computed_sha256);
    assert.match(outputs[0].notice, /서버 판정이 최종/);
    // 매니페스트를 채운 뒤에는 디렉터리 검사도 해시가 일치한다.
    assert.equal((await prepareSkillPackage(f.dir)).editor?.hash_match, true);

    const sdk = join(f.temp, 'sdk');
    await mkdir(join(sdk, 'mock-host'), { recursive: true });
    await writeFile(join(sdk, 'mock-host/serve.mjs'), '');
    ctx.options.dryRun = true;
    outputs.length = 0;
    await program.parseAsync(['node', 'clack', 'skill', 'editor', 'dev', '--sdk-dir', sdk, '--editor', f.dir + '/editor', '--document', f.dir + '/examples/basic.json', '--schema', f.dir + '/output/data.schema.json']);
    assert.equal(outputs[0].sdk_dir, sdk);
    assert.deepEqual(outputs[0].command.slice(2, 4), ['--editor', resolve(f.dir, 'editor')]);
    await assert.rejects(program.parseAsync(['node', 'clack', 'skill', 'editor', 'dev', '--sdk-dir', join(f.temp, 'none')]), /SDK/);
  } finally { await rm(f.temp, { recursive: true, force: true }); }
});

test('모노레포의 SDK 스타터 패키지가 있으면 pack이 통과한다', async (t) => {
  const starter = resolve(process.env.CLACK_MONOREPO_DIR ?? '../clack', 'clack-skill-editor-sdk/starter');
  if (!existsSync(join(starter, 'clack.skill.json'))) { t.skip('모노레포 SDK 스타터 없음'); return; }
  const temp = await mkdtemp(join(tmpdir(), 'clack-starter-'));
  try {
    const dir = join(temp, 'personality-test');
    await cp(starter, dir, { recursive: true });
    const prepared = await prepareSkillPackage(dir, { fillEditorHash: true });
    assert.equal(prepared.editor?.hash_match, true);
    assert.equal(prepared.editor?.center_only, true);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
