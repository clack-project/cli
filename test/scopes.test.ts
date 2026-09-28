import test from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { ApiClient } from '../src/core/api.js';
import type { CommandContext, Runtime } from '../src/core/types.js';
import { registerContentCommands } from '../src/commands/content.js';
import { registerPageCommands } from '../src/commands/page.js';
import { registerSkillCommands } from '../src/commands/skill.js';

// 서버의 PAT 권한 규칙을 명령별로 옮긴 표다. 두 권한이 모두 필요한 명령은 배열에 둘 다 둔다.
const EXPECTED: Record<string, Record<string, string[]>> = {
  content: {
    list: ['creator-content:read'], status: ['creator-content:read'], preview: ['creator-content:read'],
    create: ['creator-content:write'], upload: ['creator-content:write'], complete: ['creator-content:write'],
    withdraw: ['creator-content:write'], submit: ['creator-content:write', 'creator-content:publish'],
    publish: ['creator-content:publish'], unpublish: ['creator-content:publish'],
    'server-keys list': ['platform:read'], 'server-keys revoke': ['platform:write'],
    'shared collections': ['platform:read'], 'shared list': ['platform:read'], 'shared get': ['platform:read'],
    'shared hide': ['platform:write'], 'shared delete': ['platform:write'],
  },
  page: {
    list: ['custom-page:read'], status: ['custom-page:read'], preview: ['custom-page:read'],
    create: ['custom-page:write'], upload: ['custom-page:write'], complete: ['custom-page:write'], presentation: ['custom-page:write'],
    submit: ['custom-page:write', 'custom-page:publish'],
    apply: ['custom-page:publish'], restore: ['custom-page:publish'], disable: ['custom-page:publish'],
  },
  skill: {
    list: ['skill:read'], get: ['skill:read'], form: ['skill:read'], status: ['skill:read'],
    validate: ['skill:write'], push: ['skill:write'], complete: ['skill:write'], cancel: ['skill:write'],
    submit: ['skill:write', 'skill:publish'], release: ['skill:publish'], deprecate: ['skill:publish'],
  },
};

function program(): Command {
  const root = new Command().exitOverride();
  const runtime: Runtime = { action(command, handler) { command.action(async () => handler({} as CommandContext, [], {})); } };
  registerContentCommands(root, runtime);
  registerPageCommands(root, runtime);
  registerSkillCommands(root, runtime);
  return root;
}

function find(root: Command, path: string[]): Command {
  let current = root;
  for (const name of path) {
    const next = current.commands.find(command => command.name() === name);
    assert.ok(next, `명령 없음: ${path.join(' ')}`);
    current = next;
  }
  return current;
}

test('content·page·skill 하위 명령 도움말의 권한 표기는 서버 권한 규칙과 같다', () => {
  const root = program();
  for (const [group, commands] of Object.entries(EXPECTED)) {
    for (const [name, scopes] of Object.entries(commands)) {
      const description = find(root, [group, ...name.split(' ')]).description();
      const mentioned = [...new Set(description.match(/[a-z-]+:(?:read|write|publish)/g) ?? [])].sort();
      assert.deepEqual(mentioned, [...scopes].sort(), `${group} ${name}: ${description}`);
    }
  }
});

test('심사 제출 명령 도움말은 쓰기와 게시 권한이 둘 다 필요하다고 표시한다', () => {
  const root = program();
  for (const group of ['content', 'page', 'skill']) {
    // 도움말은 터미널 폭에 맞춰 줄바꿈되므로 공백을 정규화해 비교한다.
    const help = find(root, [group, 'submit']).helpInformation().replace(/\s+/g, ' ');
    assert.match(help, /둘 다 필요/, group);
  }
});

test('skill release·deprecate의 PAT 안내는 skill:publish를 요구한다', async () => {
  const skillId = '00000000-0000-4000-8000-000000000001';
  const versionId = '00000000-0000-4000-8000-000000000002';
  let called = false;
  const ctx: CommandContext = { api: new ApiClient({ baseUrl: 'https://v4-api.dev.clack.kr', token: 'not-a-pat',
    fetch: async () => { called = true; return new Response('{}'); } }), options: {}, output: () => {}, confirm: async () => {} };
  const runtime: Runtime = { action(command, handler) {
    command.action(async (...values: unknown[]) => handler(ctx, values.slice(0, -2) as string[], (values.at(-1) as Command).opts()));
  } };
  for (const args of [['release', skillId, versionId, '--visibility', 'private'], ['deprecate', skillId]]) {
    const root = new Command().exitOverride();
    registerSkillCommands(root, runtime);
    await assert.rejects(root.parseAsync(['skill', ...args], { from: 'user' }), (error: Error) =>
      /skill:publish/.test(error.message) && !/skill:write/.test(error.message), args[0]);
  }
  assert.equal(called, false);
});
