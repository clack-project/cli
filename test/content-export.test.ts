import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadCreatorExport } from '../src/lib/content-export.js';
const bytes = Buffer.from('합성 ZIP 바이트');
const data = { download_url: 'https://clack-creator-content-dev-123456789012-ap-northeast-2.s3.ap-northeast-2.amazonaws.com/_staging/7/11111111-1111-4111-8111-111111111111?signature=example', byte_size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
test('내보내기는 해시 검증 뒤 새 파일에만 쓰고 인증 토큰을 보내지 않는다', async () => {
  const dir = await mkdtemp(join(tmpdir(),'clack-export-'));
  try {
    const file = join(dir,'bundle.zip');
    const fetcher: typeof fetch = async (_url, init) => { assert.equal(init?.headers, undefined); assert.equal(init?.redirect, 'error'); return new Response(bytes); };
    await downloadCreatorExport(data, file, fetcher);
    assert.deepEqual(await readFile(file), bytes);
    await assert.rejects(downloadCreatorExport(data,file,fetcher), {code:'EEXIST'});
    await assert.rejects(downloadCreatorExport({...data,sha256:'a'.repeat(64)},join(dir,'invalid.zip'),fetcher));
    await assert.rejects(downloadCreatorExport({...data,download_url:'https://evil.example/file'},join(dir,'external.zip'),fetcher));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
