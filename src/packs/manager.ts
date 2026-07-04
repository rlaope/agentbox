import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadHarnessDir } from '../harness/markdown.js';
import type { HarnessSpec } from '../types.js';

/**
 * Harness packs — directories of markdown harnesses distributed via git or
 * shared as local folders, installed into a packs directory (default
 * .agentbox/packs). One pack = one task-type collection; installing a pack
 * and loading it is how a deployment grows new capabilities without code.
 */

/** Optional manifest at the pack root. Everything works without it. */
export interface PackManifest {
  name?: string;
  version?: string;
  description?: string;
  /** Directory containing the harness *.md files, relative to the pack root. */
  harnesses?: string;
}

export interface PackInfo {
  name: string;
  /** Absolute pack root */
  dir: string;
  /** Absolute directory the harness files load from */
  harnessDir: string;
  version?: string;
  description?: string;
  /** Where the pack was installed from (git URL or local path) */
  source?: string;
}

const MANIFEST_FILE = 'agentbox-pack.json';
const META_FILE = '.agentbox-pack-source.json';

export function isGitSource(source: string): boolean {
  return (
    source.startsWith('git@') ||
    source.startsWith('git://') ||
    source.endsWith('.git') ||
    /^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\//.test(source)
  );
}

function packNameFrom(source: string): string {
  const base = source.replace(/\/+$/, '').split('/').pop() ?? 'pack';
  return base.replace(/\.git$/, '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function readJsonIfExists<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function resolvePackInfo(dir: string): Promise<PackInfo> {
  const manifest = (await readJsonIfExists<PackManifest>(path.join(dir, MANIFEST_FILE))) ?? {};
  const meta = await readJsonIfExists<{ source?: string }>(path.join(dir, META_FILE));
  let harnessDir = dir;
  if (manifest.harnesses) {
    harnessDir = path.resolve(dir, manifest.harnesses);
  } else {
    const conventional = path.join(dir, 'harnesses');
    try {
      if ((await fs.stat(conventional)).isDirectory()) harnessDir = conventional;
    } catch {
      // No harnesses/ subdir; harness files live at the pack root.
    }
  }
  return {
    name: manifest.name ?? path.basename(dir),
    dir,
    harnessDir,
    version: manifest.version,
    description: manifest.description,
    source: meta?.source,
  };
}

function gitClone(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--depth', '1', url, dest], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git clone failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}

export interface InstallOptions {
  /** Override the pack directory name (defaults to the source basename) */
  name?: string;
  /** Replace an existing installation of the same name */
  force?: boolean;
}

export class PackManager {
  constructor(private readonly packsDir: string) {}

  /**
   * Installs a pack from a git URL or a local directory (copied, not linked).
   * The pack is fetched and validated in a staging directory first, so a
   * broken pack never lands in the packs directory. The installed name is
   * opts.name, else the manifest name, else the source basename.
   */
  async install(source: string, opts: InstallOptions = {}): Promise<PackInfo> {
    await fs.mkdir(this.packsDir, { recursive: true });
    const staging = await fs.mkdtemp(path.join(this.packsDir, '.staging-'));
    const stagingPack = path.join(staging, 'pack');
    try {
      if (isGitSource(source)) {
        await gitClone(source, stagingPack);
        await fs.rm(path.join(stagingPack, '.git'), { recursive: true, force: true });
      } else {
        const abs = path.resolve(source);
        const stat = await fs.stat(abs).catch(() => undefined);
        if (!stat?.isDirectory()) throw new Error(`pack source "${source}" is not a directory or git URL`);
        await fs.cp(abs, stagingPack, { recursive: true });
      }
      await fs.writeFile(path.join(stagingPack, META_FILE), JSON.stringify({ source }, null, 2));

      // Fail fast on a pack whose harness files do not even parse.
      const stagingInfo = await resolvePackInfo(stagingPack);
      await loadHarnessDir(stagingInfo.harnessDir);

      const manifest = await readJsonIfExists<PackManifest>(path.join(stagingPack, MANIFEST_FILE));
      const name = opts.name ?? manifest?.name ?? packNameFrom(source);
      const dest = path.join(this.packsDir, name);
      const exists = await fs
        .stat(dest)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        if (!opts.force) throw new Error(`pack "${name}" is already installed (use force to replace)`);
        await fs.rm(dest, { recursive: true, force: true });
      }
      await fs.rename(stagingPack, dest);
      return await resolvePackInfo(dest);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  async list(): Promise<PackInfo[]> {
    let entries;
    try {
      entries = await fs.readdir(this.packsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const packs: PackInfo[] = [];
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of dirs) {
      packs.push(await resolvePackInfo(path.join(this.packsDir, entry.name)));
    }
    return packs;
  }

  /** Removes by pack name (manifest-aware), matching what list() displays. */
  async remove(name: string): Promise<boolean> {
    for (const pack of await this.list()) {
      if (pack.name === name) {
        await fs.rm(pack.dir, { recursive: true, force: true });
        return true;
      }
    }
    return false;
  }

  /** Harness specs of every installed pack, in pack-name order. */
  async harnesses(): Promise<Array<{ pack: PackInfo; specs: HarnessSpec[] }>> {
    const result: Array<{ pack: PackInfo; specs: HarnessSpec[] }> = [];
    for (const pack of await this.list()) {
      result.push({ pack, specs: await loadHarnessDir(pack.harnessDir) });
    }
    return result;
  }
}
