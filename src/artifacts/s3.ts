import { createHash, createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Artifact, ArtifactStore } from '../types.js';

/**
 * S3-compatible artifact store with hand-rolled SigV4 signing, keeping the
 * framework free of the AWS SDK. Works against AWS S3 and S3-compatible
 * endpoints (MinIO, R2) via the endpoint option.
 */
export interface S3ArtifactStoreOptions {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Key prefix inside the bucket (default "agentbox/") */
  prefix?: string;
  /** Override the endpoint for S3-compatible stores, e.g. "https://minio.local:9000" */
  endpoint?: string;
  /** Injectable for tests */
  fetchImpl?: typeof fetch;
}

const EMPTY_HASH = createHash('sha256').update('').digest('hex');

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export class S3ArtifactStore implements ArtifactStore {
  private readonly prefix: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: S3ArtifactStoreOptions) {
    this.prefix = opts.prefix ?? 'agentbox/';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private hostAndUrl(key: string): { host: string; url: string; canonicalPath: string } {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    if (this.opts.endpoint) {
      const endpoint = new URL(this.opts.endpoint);
      return {
        host: endpoint.host,
        url: `${endpoint.origin}/${this.opts.bucket}/${encodedKey}`,
        canonicalPath: `/${this.opts.bucket}/${encodedKey}`,
      };
    }
    const host = `${this.opts.bucket}.s3.${this.opts.region}.amazonaws.com`;
    return { host, url: `https://${host}/${encodedKey}`, canonicalPath: `/${encodedKey}` };
  }

  /** SigV4-signed PUT of one object. Exposed for testing. */
  async putObject(key: string, body: Buffer): Promise<string> {
    const { host, url, canonicalPath } = this.hostAndUrl(key);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = body.length === 0 ? EMPTY_HASH : createHash('sha256').update(body).digest('hex');

    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (this.opts.sessionToken) headers['x-amz-security-token'] = this.opts.sessionToken;

    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]}\n`).join('');
    const signedHeaders = signedHeaderNames.join(';');
    const canonicalRequest = ['PUT', canonicalPath, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

    const scope = `${dateStamp}/${this.opts.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const kDate = hmac(`AWS4${this.opts.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.opts.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${this.opts.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const response = await this.fetchImpl(url, {
      method: 'PUT',
      headers: { ...headers, authorization },
      body: new Uint8Array(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`S3 PUT ${key} failed: ${response.status} ${detail.slice(0, 300)}`);
    }
    return url;
  }

  async store(runId: string, artifacts: Artifact[]): Promise<Artifact[]> {
    const stored: Artifact[] = [];
    for (const artifact of artifacts) {
      const key = `${this.prefix}${runId}/${artifact.path}`;
      const body = await fs.readFile(artifact.absPath);
      const url = await this.putObject(key, body);
      stored.push({ ...artifact, url });
    }
    return stored;
  }
}
