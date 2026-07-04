import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { WorkspaceSpec } from '../types.js';
import { runCommand, seedWorkspace } from './workspace.js';

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Pre-materialized workspace snapshots (Daytona-style). Expensive setup —
 * template copies, seed files, dependency installs — happens once at
 * snapshot creation; new sessions then clone the snapshot with
 * copy-on-write speed instead of repeating the setup. A harness opts in
 * with `workspace.snapshot: <name>`.
 */
export class SnapshotManager {
  constructor(private readonly dir: string) {}

  /**
   * Builds a snapshot: seeds the workspace spec, optionally runs a prepare
   * command inside it (e.g. ["npm", "install"]), and lands it atomically.
   */
  async create(
    name: string,
    workspace: WorkspaceSpec = {},
    opts: { prepare?: string[]; force?: boolean } = {},
  ): Promise<string> {
    if (!NAME_RE.test(name)) throw new Error(`invalid snapshot name "${name}" (expected ${NAME_RE})`);
    if (workspace.snapshot) throw new Error('a snapshot cannot be built from another snapshot');
    await fs.mkdir(this.dir, { recursive: true });
    const staging = await fs.mkdtemp(path.join(this.dir, '.staging-'));
    const stagingRoot = path.join(staging, 'snapshot');
    try {
      await seedWorkspace(stagingRoot, workspace);
      if (opts.prepare?.length) {
        await runCommand(opts.prepare[0], opts.prepare.slice(1), stagingRoot);
      }
      const dest = path.join(this.dir, name);
      const exists = await fs
        .stat(dest)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        if (!opts.force) throw new Error(`snapshot "${name}" already exists (use force to rebuild)`);
        await fs.rm(dest, { recursive: true, force: true });
      }
      await fs.rename(stagingRoot, dest);
      return dest;
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  async list(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  async remove(name: string): Promise<boolean> {
    const dest = path.join(this.dir, name);
    const exists = await fs
      .stat(dest)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (!exists) return false;
    await fs.rm(dest, { recursive: true, force: true });
    return true;
  }
}
