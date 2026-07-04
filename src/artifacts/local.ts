import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Artifact, ArtifactStore } from '../types.js';

/**
 * Copies run artifacts into an archive directory (<dir>/<runId>/<relPath>).
 * Sessions get reaped with their workspaces; the archive is what survives.
 */
export class LocalArtifactStore implements ArtifactStore {
  constructor(private readonly dir: string) {}

  async store(runId: string, artifacts: Artifact[]): Promise<Artifact[]> {
    const stored: Artifact[] = [];
    for (const artifact of artifacts) {
      const dest = path.join(this.dir, runId, artifact.path);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(artifact.absPath, dest);
      stored.push({ ...artifact, url: pathToFileURL(dest).href });
    }
    return stored;
  }
}
