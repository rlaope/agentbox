import http from 'node:http';
import net from 'node:net';

/**
 * Domain-allowlisting egress proxy. Container runs point HTTP_PROXY /
 * HTTPS_PROXY here so an agent's network reach is a declared list of
 * domains (the model API, a package registry) instead of the whole
 * internet — shrinking the data-exfiltration channel under prompt
 * injection.
 *
 * HTTPS goes through CONNECT tunnels (destination hostname is checked,
 * content stays end-to-end encrypted); plain HTTP is forwarded by
 * absolute-URI. This is a policy point for proxy-honoring clients;
 * for hard deny-all use the container `network: 'none'` mode instead.
 */
export interface EgressProxyOptions {
  /** Exact domains or `*.suffix` wildcards, e.g. ["api.anthropic.com", "*.npmjs.org"] */
  allowedDomains: string[];
  /** Listen port; 0 (default) picks an ephemeral port. */
  port?: number;
  /** Listen host; defaults to 0.0.0.0 so containers can reach it. */
  host?: string;
}

export interface EgressProxy {
  port: number;
  url: string;
  /** Hostnames denied so far (for observability/alerting). */
  denied: string[];
  close(): Promise<void>;
}

export function domainAllowed(hostname: string, allowed: string[]): boolean {
  const target = hostname.toLowerCase().replace(/\.$/, '');
  for (const raw of allowed) {
    const rule = raw.toLowerCase();
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(1); // ".example.com"
      if (target.endsWith(suffix) && target.length > suffix.length) return true;
    } else if (target === rule) {
      return true;
    }
  }
  return false;
}

export function startEgressProxy(opts: EgressProxyOptions): Promise<EgressProxy> {
  const denied: string[] = [];

  const server = http.createServer((req, res) => {
    // Plain-HTTP forward proxying via absolute-URI requests.
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('proxy requires absolute-URI requests');
      return;
    }
    if (!domainAllowed(url.hostname, opts.allowedDomains)) {
      denied.push(url.hostname);
      res.writeHead(403).end(`egress to ${url.hostname} is not allowed`);
      return;
    }
    const upstream = http.request(
      url,
      { method: req.method, headers: { ...req.headers, host: url.host } },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });

  // HTTPS tunneling: check the CONNECT target hostname, then splice bytes.
  server.on('connect', (req, clientSocket, head) => {
    const [host, portRaw] = (req.url ?? '').split(':');
    const port = Number(portRaw || 443);
    if (!host || !domainAllowed(host, opts.allowedDomains)) {
      denied.push(host ?? 'unknown');
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const drop = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on('error', drop);
    clientSocket.on('error', drop);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '0.0.0.0', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        url: `http://host.docker.internal:${port}`,
        denied,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
