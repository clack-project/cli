import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CliError } from '../core/errors.js';

/** 전용 비공개 저장소 URL만 열고 토큰 없이 받은 바이트를 검증한다. */
export async function downloadCreatorExport(data: { download_url: string; byte_size: number; sha256: string }, output: string, fetcher: typeof fetch = fetch) {
  let url: URL;
  try {
    url = new URL(data.download_url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || !/^clack-creator-content-(dev|prod)-\d{12}-[a-z0-9-]+\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)
      || !/^\/_staging\/\d+\/[a-f0-9-]{36}$/.test(url.pathname)) throw new Error();
  } catch { throw new CliError('콘텐츠 전용 내려받기 주소를 확인할 수 없습니다.'); }
  if (!Number.isSafeInteger(data.byte_size) || data.byte_size <= 0 || data.byte_size > 32 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(data.sha256)) throw new CliError('내려받기 명세를 확인할 수 없습니다.');
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new CliError('ZIP 내려받기에 실패했습니다. 새 링크를 발급하세요.');
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const bytes of response.body) { size += bytes.byteLength; if (size > data.byte_size) throw new CliError('ZIP 크기가 명세를 초과했습니다.'); chunks.push(bytes); }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== data.byte_size || createHash('sha256').update(bytes).digest('hex') !== data.sha256) throw new CliError('ZIP 크기 또는 SHA-256이 일치하지 않습니다.');
  const path = resolve(output); await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  return { path, byte_size: bytes.length, sha256: data.sha256 };
}
