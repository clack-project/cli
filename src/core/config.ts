import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CliError } from './errors.js';
import { rememberSecret } from './secrets.js';
import type { GlobalOptions } from './types.js';

export const BASE_URLS = { prod: 'https://v4-api.clack.kr', dev: 'https://v4-api.dev.clack.kr' };
// 프로필을 명시하지 않았을 때 쓰는 기본 프로필 이름. env 값('prod'/'dev')과 겹치지 않는 중립적인 이름을 써서
// "profile":"prod"가 dev 원점과 함께 표시되는 혼란(D6)을 막는다.
const DEFAULT_PROFILE = 'default';
// 이전 개발 빌드는 기본 프로필 이름을 'prod'로 저장했다. 프로필을 명시하지 않았고 새 기본 프로필에
// 아무 것도 없을 때만 읽기 호환으로 이어서 쓴다(다음 로그인 시 자연스럽게 'default'로 옮겨간다).
const LEGACY_DEFAULT_PROFILE = 'prod';
export interface ProfileConfig {
  env?: 'prod' | 'dev'; base_url?: string; time?: 'local' | 'utc'; lang?: 'ko' | 'en'; output?: 'json' | 'human';
}
export interface Credential {
  token: string; base_url: string; scopes: string[]; expires_at: string;
  user?: { id: number; name: string | null; avatar?: string | null }; token_id?: number;
}
export interface ResolvedConfig {
  profile: string; baseUrl: string; token?: string; credential?: Credential; tokenFromEnv: boolean;
  options: GlobalOptions; lang: string;
}

export function validateBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new CliError('API 주소를 확인하세요.'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new CliError('API 주소는 HTTPS 원점 또는 로컬 HTTP 원점이어야 합니다.');
  return url.origin;
}
export function validateToken(value: string): string {
  const token = value.trim();
  rememberSecret(token);
  if (!/^pat_[a-f0-9]{64}$/.test(token)) throw new CliError('개인 액세스 토큰(pat_)을 입력하세요.', 'INVALID_TOKEN');
  return token;
}
function validateProfile(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new CliError('프로필 이름을 확인하세요.');
  return value;
}

export function validateConfigValue(key: string, value: string): string {
  const allowed: Record<string, string[]> = { env: ['prod', 'dev'], time: ['local', 'utc'], lang: ['ko', 'en'], output: ['json', 'human'] };
  if (key === 'base_url') return validateBaseUrl(value);
  if (!Object.hasOwn(allowed, key) || !allowed[key]?.includes(value)) throw new CliError('설정 키·값을 확인하세요. env, base_url, time, lang, output만 지원합니다.');
  return value;
}

export class ConfigStore {
  readonly directory: string;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    this.directory = env.CLACK_CONFIG_DIR || (process.platform === 'win32' ? join(env.APPDATA || homedir(), 'clack') : join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'clack'));
  }
  private async read<T>(name: string): Promise<{ profiles: Record<string, T> }> {
    const path = join(this.directory, name);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new CliError('설정 파일은 일반 파일이어야 합니다.', 'CONFIG_UNSAFE');
      if (name === 'credentials.json' && process.platform !== 'win32') await chmod(path, 0o600);
      const body: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!body || typeof body !== 'object' || !('profiles' in body) || !body.profiles || typeof body.profiles !== 'object' || Array.isArray(body.profiles)) throw new Error('형식');
      return body as { profiles: Record<string, T> };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: {} };
      if (error instanceof CliError) throw error;
      throw new CliError('설정 파일을 읽지 못했습니다. 파일 형식과 접근 권한을 확인하세요.', 'CONFIG_READ_ERROR');
    }
  }
  private async write<T>(name: string, value: { profiles: Record<string, T> }): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const dir = await lstat(this.directory);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new CliError('설정 폴더는 심볼릭 링크일 수 없습니다.', 'CONFIG_UNSAFE');
    if (process.platform !== 'win32') await chmod(this.directory, 0o700);
    const temp = join(this.directory, `.${name}.${randomUUID()}.tmp`);
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
      await rename(temp, join(this.directory, name));
    } finally { await unlink(temp).catch(() => {}); }
  }
  async resolve(options: GlobalOptions = {}, ignoreCredential = false): Promise<ResolvedConfig> {
    if (options.env && !['prod', 'dev'].includes(options.env)) throw new CliError('--env는 prod 또는 dev여야 합니다.');
    // 프로필은 --env와 무관하게 정해진다: --env/config set env는 프로필이 아니라 그 프로필이 가리키는
    // 환경(주소)만 고른다. 그래야 config set env dev로 로그인한 뒤 --env dev를 붙이거나 떼도,
    // 또는 login --env dev로 바로 연결해도 항상 같은 프로필의 같은 자격을 쓴다(D6).
    const explicitProfile = options.profile ?? this.env.CLACK_PROFILE;
    let profile = validateProfile(explicitProfile ?? DEFAULT_PROFILE);
    const configFile = await this.read<ProfileConfig>('config.json');
    const credentialFile = ignoreCredential ? undefined : await this.read<Credential>('credentials.json');
    if (!explicitProfile && profile === DEFAULT_PROFILE && !configFile.profiles[DEFAULT_PROFILE]
      && !(credentialFile && credentialFile.profiles[DEFAULT_PROFILE])
      && (configFile.profiles[LEGACY_DEFAULT_PROFILE] || (credentialFile && credentialFile.profiles[LEGACY_DEFAULT_PROFILE]))) {
      profile = LEGACY_DEFAULT_PROFILE;
    }
    const config = configFile.profiles[profile] ?? {};
    const environment = options.env ?? config.env ?? (profile === 'dev' ? 'dev' : 'prod');
    const baseUrl = validateBaseUrl(options.baseUrl ?? this.env.CLACK_API_BASE ?? (options.env ? BASE_URLS[options.env] : config.base_url) ?? BASE_URLS[environment]);
    const credential = ignoreCredential ? undefined : credentialFile!.profiles[profile];
    const envToken = this.env.CLACK_TOKEN;
    if (!ignoreCredential && !envToken && credential && credential.base_url !== baseUrl) throw new CliError('저장된 토큰의 API 주소와 다릅니다. 대상 주소에서 clack login을 다시 실행하세요.', 'TOKEN_ORIGIN_MISMATCH', 401);
    const token = ignoreCredential ? undefined : envToken ? validateToken(envToken) : credential ? validateToken(credential.token) : undefined;
    const time = options.time ?? config.time ?? 'local';
    if (!['local', 'utc'].includes(time)) throw new CliError('--time은 local 또는 utc여야 합니다.');
    const lang = this.env.CLACK_LANG ?? config.lang ?? 'ko';
    if (!['ko', 'en'].includes(lang)) throw new CliError('언어는 ko 또는 en이어야 합니다.');
    return { profile, baseUrl, token, credential, tokenFromEnv: Boolean(envToken), lang,
      options: { ...options, time, json: options.json ?? config.output === 'json' } };
  }
  async saveCredential(profile: string, credential: Credential): Promise<void> {
    const all = await this.read<Credential>('credentials.json');
    all.profiles[validateProfile(profile)] = credential;
    await this.write('credentials.json', all);
  }
  async removeCredential(profile: string): Promise<void> {
    const all = await this.read<Credential>('credentials.json');
    delete all.profiles[validateProfile(profile)];
    await this.write('credentials.json', all);
  }
  async getConfig(profile: string): Promise<ProfileConfig> { return (await this.read<ProfileConfig>('config.json')).profiles[validateProfile(profile)] ?? {}; }
  async setConfig(profile: string, key: string, value: string): Promise<void> {
    value = validateConfigValue(key, value);
    const all = await this.read<ProfileConfig>('config.json');
    all.profiles[validateProfile(profile)] = { ...all.profiles[profile], [key]: value };
    // 환경을 명시적으로 전환하면 이전 로그인에서 저장한 원점보다 새 환경을 우선한다.
    if (key === 'env') delete all.profiles[profile]!.base_url;
    await this.write('config.json', all);
  }
}
