import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CommandSpec, SandboxKind, SandboxProvider, Sandbox, WorkspaceSpec } from '../types.js';
import { LocalSandbox } from './local.js';

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
    for (const name of o.envPassthrough) {
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
      ...opts,
    };
  }

  async create(id: string, spec?: WorkspaceSpec): Promise<Sandbox> {
    const root = path.resolve(this.baseDir, id);
    await fs.mkdir(root, { recursive: true });
    if (spec?.templateDir) {
      await fs.cp(spec.templateDir, root, { recursive: true });
    }
    if (this.opts.persistHome) {
      await fs.mkdir(path.join(root, HOME_DIR), { recursive: true });
    }
    const sandbox = new ContainerSandbox(root, this.opts);
    for (const [rel, content] of Object.entries(spec?.seedFiles ?? {})) {
      await sandbox.writeFile(rel, content);
    }
    return sandbox;
  }
}
