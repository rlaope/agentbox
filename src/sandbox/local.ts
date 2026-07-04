import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Artifact, CommandSpec, Sandbox, SandboxKind, SandboxProvider, WorkspaceSpec } from '../types.js';
import { globToRegExp, matchesAny } from '../util/glob.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.agentbox-home']);

/**
 * Process-level isolation sandbox. Each session gets a dedicated workspace
 * directory under baseDir and reads/writes only inside it. Deployments that
 * need a hard trust boundary plug a container/microVM implementation in
 * behind the SandboxProvider interface instead.
 */
export class LocalSandbox implements Sandbox {
  readonly kind: SandboxKind = 'local';

  constructor(readonly root: string) {}

  wrapCommand(spec: CommandSpec): CommandSpec {
    return spec;
  }

  private resolveInside(relPath: string): string {
    const abs = path.resolve(this.root, relPath);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error(`path escapes sandbox root: ${relPath}`);
    }
    return abs;
  }

  async writeFile(relPath: string, content: string | Uint8Array): Promise<void> {
    const abs = this.resolveInside(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }

  async collect(globs: string[]): Promise<Artifact[]> {
    const patterns = globs.map(globToRegExp);
    const artifacts: Artifact[] = [];
    await this.walk(this.root, '', patterns, artifacts);
    artifacts.sort((a, b) => a.path.localeCompare(b.path));
    return artifacts;
  }

  private async walk(absDir: string, relDir: string, patterns: RegExp[], out: Artifact[]): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await this.walk(abs, rel, patterns, out);
      } else if (entry.isFile() && matchesAny(rel, patterns)) {
        const stat = await fs.stat(abs);
        out.push({ path: rel, absPath: abs, bytes: stat.size });
      }
    }
  }

  async usage(): Promise<number> {
    return this.usageOf(this.root);
  }

  private async usageOf(absDir: string): Promise<number> {
    let total = 0;
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        total += await this.usageOf(abs);
      } else if (entry.isFile()) {
        try {
          total += (await fs.stat(abs)).size;
        } catch {
          // File vanished mid-walk; ignore.
        }
      }
    }
    return total;
  }

  async destroy(): Promise<void> {
    await fs.rm(this.root, { recursive: true, force: true });
  }
}

export class LocalSandboxProvider implements SandboxProvider {
  readonly kind = 'local' as const;

  constructor(private readonly baseDir: string) {}

  async create(id: string, spec?: WorkspaceSpec): Promise<Sandbox> {
    const root = path.resolve(this.baseDir, id);
    await fs.mkdir(root, { recursive: true });
    if (spec?.templateDir) {
      await fs.cp(spec.templateDir, root, { recursive: true });
    }
    const sandbox = new LocalSandbox(root);
    for (const [rel, content] of Object.entries(spec?.seedFiles ?? {})) {
      await sandbox.writeFile(rel, content);
    }
    return sandbox;
  }
}
