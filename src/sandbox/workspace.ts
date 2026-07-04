import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { WorkspaceSpec } from '../types.js';

/** Shared workspace materialization used by every sandbox provider. */
export async function seedWorkspace(root: string, spec: WorkspaceSpec | undefined, snapshotsDir?: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  if (spec?.snapshot) {
    if (!snapshotsDir) {
      throw new Error(`workspace.snapshot "${spec.snapshot}" requires a snapshots directory`);
    }
    const source = path.join(snapshotsDir, spec.snapshot);
    const ok = await fs
      .stat(source)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (!ok) throw new Error(`unknown workspace snapshot "${spec.snapshot}"`);
    await cloneDir(source, root);
  }
  if (spec?.templateDir) {
    await fs.cp(spec.templateDir, root, { recursive: true });
  }
  for (const [rel, content] of Object.entries(spec?.seedFiles ?? {})) {
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`seed file escapes workspace root: ${rel}`);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

/**
 * Fast directory clone: copy-on-write when the filesystem supports it
 * (APFS clonefile via `cp -Rc`, btrfs/xfs reflink via `cp --reflink=auto`),
 * falling back to a regular recursive copy.
 */
export async function cloneDir(source: string, dest: string): Promise<void> {
  const args =
    process.platform === 'darwin'
      ? ['-Rc', `${source}/.`, dest]
      : ['-a', '--reflink=auto', `${source}/.`, dest];
  try {
    await runCommand('cp', args);
  } catch {
    await fs.cp(source, dest, { recursive: true });
  }
}

export function runCommand(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
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
