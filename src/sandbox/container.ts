import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CommandSpec, SandboxKind, SandboxProvider, Sandbox, WorkspaceSpec } from '../types.js';
import { LocalSandbox } from './local.js';
import { seedWorkspace } from './workspace.js';

/**
 * Docker-based isolation. The workspace stays a host directory (volume =
 * session), so file seeding and artifact collection are identical to the
 * local sandbox; only execution crosses the container boundary. Each run
 * spawns an ephemeral container (`docker run --rm`) with the workspace
 * bind-mounted — the execution environment is leased per run, not held
 * per session.
 */
export interface ContainerSandboxOptions {
  /** Image the agent CLI runs in. It must have the backend CLIs installed. */
  image: string;
  /** Directory holding workspace snapshots for workspace.snapshot cloning. */
  snapshotsDir?: string;
  /** Container runtime binary. Defaults to "docker" (podman-compatible). */
  runtime?: string;
  /** Docker network mode. Defaults to "bridge" — agent CLIs need the model API. */
  network?: string;
  /** Mount point of the workspace inside the container. Defaults to /workspace. */
  workdir?: string;
  /**
   * Environment variable names forwarded into the container (docker `-e NAME`
   * picks the value up from the spawning process). Defaults to the API keys.
   */
  envPassthrough?: string[];
  /** Extra `docker run` arguments (resource limits, seccomp profiles, …). */
  extraArgs?: string[];
  /**
   * Mount a per-session home directory so backend resume state (claude
   * session ids, codex threads) survives across ephemeral containers.
   * Defaults to true.
   */
  persistHome?: boolean;
  /**
   * Egress policy point: HTTP_PROXY/HTTPS_PROXY are set to this URL inside
   * the container (typically a startEgressProxy() instance) and
   * host.docker.internal is mapped to the host gateway. Enforces the domain
   * allowlist for proxy-honoring clients; pair with network "none" for
   * hard deny-all.
   */
  egressProxyUrl?: string;
}

const HOME_DIR = '.agentbox-home';
const HOME_MOUNT = '/agentbox-home';

type ResolvedOptions = Required<ContainerSandboxOptions>;

export class ContainerSandbox extends LocalSandbox {
  override readonly kind: SandboxKind = 'container';

  constructor(
    root: string,
    private readonly copts: ResolvedOptions,
  ) {
    super(root);
  }

  override wrapCommand(spec: CommandSpec): CommandSpec {
    const o = this.copts;
    const args = [
      'run',
      '--rm',
      '--network',
      o.network,
      '-v',
      `${this.root}:${o.workdir}`,
      '-w',
      o.workdir,
    ];
    if (o.persistHome) {
      args.push('-v', `${path.join(this.root, HOME_DIR)}:${HOME_MOUNT}`, '-e', `HOME=${HOME_MOUNT}`);
    }
    if (o.egressProxyUrl) {
      args.push('--add-host', 'host.docker.internal:host-gateway');
      for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
        args.push('-e', `${name}=${o.egressProxyUrl}`);
      }
    }
    for (const name of o.envPassthrough) {
      args.push('-e', name);
    }
    // Invocation-scoped env (e.g. harness env allowlists) — values travel via
    // the docker client process env, `-e NAME` forwards them into the container.
    for (const name of Object.keys(spec.env ?? {})) {
      args.push('-e', name);
    }
    args.push(...o.extraArgs, o.image, spec.command, ...spec.args);
    return { command: o.runtime, args, env: spec.env };
  }
}

export class ContainerSandboxProvider implements SandboxProvider {
  readonly kind = 'container' as const;
  private readonly opts: ResolvedOptions;

  constructor(
    private readonly baseDir: string,
    opts: ContainerSandboxOptions,
  ) {
    this.opts = {
      runtime: 'docker',
      network: 'bridge',
      workdir: '/workspace',
      envPassthrough: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
      extraArgs: [],
      persistHome: true,
      snapshotsDir: opts.snapshotsDir ?? '',
      egressProxyUrl: opts.egressProxyUrl ?? '',
      ...opts,
    };
  }

  async create(id: string, spec?: WorkspaceSpec): Promise<Sandbox> {
    const root = path.resolve(this.baseDir, id);
    await seedWorkspace(root, spec, this.opts.snapshotsDir || undefined);
    if (this.opts.persistHome) {
      await fs.mkdir(path.join(root, HOME_DIR), { recursive: true });
    }
    return new ContainerSandbox(root, this.opts);
  }

  /**
   * Image-level warm pool: pre-pulls the run image so the first real run
   * doesn't pay pull latency. Runs stay ephemeral (`docker run --rm`) for
   * isolation — the "pool" is the locally cached image, not live containers.
   * Call once at boot; resolves true once the image is present locally.
   */
  async warm(): Promise<boolean> {
    try {
      await runContainerCommand(this.opts.runtime, ['image', 'inspect', this.opts.image]);
      return true; // already cached
    } catch {
      // not present — pull it
    }
    await runContainerCommand(this.opts.runtime, ['pull', this.opts.image]);
    return true;
  }
}

function runContainerCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args[0]} failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}
