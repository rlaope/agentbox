import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agentbox } from '../src/agentbox.js';
import { LocalArtifactStore } from '../src/artifacts/local.js';
import { S3ArtifactStore } from '../src/artifacts/s3.js';
import type { AgentDriver, DriverContext, DriverOutcome } from '../src/types.js';

class WritingDriver implements AgentDriver {
  readonly backend = 'claude' as const;
  async run(ctx: DriverContext): Promise<DriverOutcome> {
    await ctx.sandbox.writeFile('out/deck.txt', 'deck content');
    return { status: 'succeeded', finalText: 'done' };
  }
}

test('LocalArtifactStore archives artifacts per run and annotates urls', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-store-'));
  const archiveDir = path.join(baseDir, 'archive');
  const box = new Agentbox({
    baseDir,
    drivers: { claude: new WritingDriver() },
    artifactStore: new LocalArtifactStore(archiveDir),
  });
  box.register({ name: 'task', backend: 'claude', artifacts: { globs: ['out/**'] } });

  const result = await box.run({ session: { userId: 'u', goalId: 'g' }, harness: 'task', prompt: 'x' });
  assert.equal(result.status, 'succeeded');
  assert.match(result.artifacts[0].url ?? '', /^file:\/\//);

  const archived = path.join(archiveDir, result.runId, 'out/deck.txt');
  assert.equal(await fs.readFile(archived, 'utf8'), 'deck content');
  await box.close();
});

test('artifact store failures turn the run into a failed result', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-store-fail-'));
  const box = new Agentbox({
    baseDir,
    drivers: { claude: new WritingDriver() },
    artifactStore: {
      store: async () => {
        throw new Error('bucket unavailable');
      },
    },
  });
  box.register({ name: 'task', backend: 'claude', artifacts: { globs: ['out/**'] } });

  const result = await box.run({ session: { userId: 'u', goalId: 'g' }, harness: 'task', prompt: 'x' });
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /artifact store: bucket unavailable/);
  await box.close();
});

test('S3ArtifactStore signs SigV4 PUTs and uploads each artifact', async () => {
  const requests: Array<{ url: string; headers: Record<string, string>; bodyLength: number }> = [];
  const fetchImpl = (async (url: any, init: any) => {
    requests.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      bodyLength: (init.body as Uint8Array).byteLength,
    });
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-s3-'));
  const file = path.join(dir, 'deck.pptx');
  await fs.writeFile(file, 'binary-ish');

  const store = new S3ArtifactStore({
    bucket: 'my-bucket',
    region: 'ap-northeast-2',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret',
    fetchImpl,
  });
  const stored = await store.store('run-1', [{ path: 'out/deck.pptx', absPath: file, bytes: 10 }]);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://my-bucket.s3.ap-northeast-2.amazonaws.com/agentbox/run-1/out/deck.pptx');
  assert.equal(requests[0].bodyLength, 10);
  const auth = requests[0].headers.authorization;
  assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/ap-northeast-2\/s3\/aws4_request/);
  assert.match(auth, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
  assert.match(auth, /Signature=[0-9a-f]{64}$/);
  assert.match(requests[0].headers['x-amz-content-sha256'], /^[0-9a-f]{64}$/);
  assert.equal(stored[0].url, requests[0].url);
});

test('S3ArtifactStore custom endpoint uses path-style bucket addressing', async () => {
  const urls: string[] = [];
  const fetchImpl = (async (url: any) => {
    urls.push(String(url));
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-s3-ep-'));
  const file = path.join(dir, 'a.txt');
  await fs.writeFile(file, 'x');

  const store = new S3ArtifactStore({
    bucket: 'b',
    region: 'us-east-1',
    accessKeyId: 'k',
    secretAccessKey: 's',
    endpoint: 'https://minio.local:9000',
    prefix: '',
    fetchImpl,
  });
  await store.store('r', [{ path: 'a.txt', absPath: file, bytes: 1 }]);
  assert.equal(urls[0], 'https://minio.local:9000/b/r/a.txt');
});

test('failed S3 responses surface status and body', async () => {
  const fetchImpl = (async () => new Response('AccessDenied', { status: 403 })) as typeof fetch;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-s3-err-'));
  const file = path.join(dir, 'a.txt');
  await fs.writeFile(file, 'x');
  const store = new S3ArtifactStore({
    bucket: 'b',
    region: 'us-east-1',
    accessKeyId: 'k',
    secretAccessKey: 's',
    fetchImpl,
  });
  await assert.rejects(store.store('r', [{ path: 'a.txt', absPath: file, bytes: 1 }]), /403 AccessDenied/);
});
