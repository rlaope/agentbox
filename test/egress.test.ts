import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { domainAllowed, startEgressProxy } from '../src/server/egress.js';

test('domain allowlist matches exact hosts and wildcard suffixes only', () => {
  const rules = ['api.anthropic.com', '*.npmjs.org'];
  assert.ok(domainAllowed('api.anthropic.com', rules));
  assert.ok(domainAllowed('registry.npmjs.org', rules));
  assert.ok(domainAllowed('API.Anthropic.com', rules)); // case-insensitive
  assert.ok(!domainAllowed('anthropic.com', rules));
  assert.ok(!domainAllowed('npmjs.org', rules)); // bare suffix is not a subdomain
  assert.ok(!domainAllowed('evil.com', rules));
  assert.ok(!domainAllowed('api.anthropic.com.evil.com', rules));
});

test('proxy forwards allowed plain-HTTP requests and blocks the rest', async () => {
  // A stand-in upstream the proxy is allowed to reach.
  const upstream = http.createServer((_req, res) => res.end('upstream-ok'));
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const proxy = await startEgressProxy({ allowedDomains: ['127.0.0.1'], host: '127.0.0.1' });

  const viaProxy = (target: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxy.port, method: 'GET', path: target, headers: { host: new URL(target).host } },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });

  const allowed = await viaProxy(`http://127.0.0.1:${upstreamPort}/`);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body, 'upstream-ok');

  const blocked = await viaProxy('http://evil.com/');
  assert.equal(blocked.status, 403);
  assert.ok(proxy.denied.includes('evil.com'));

  await proxy.close();
  await new Promise((r) => upstream.close(r));
});
