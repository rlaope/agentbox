#!/usr/bin/env node
import path from 'node:path';
import { PackManager } from './packs/manager.js';

/**
 * Minimal pack CLI:
 *   agentbox add <git-url|local-dir> [--name <name>] [--force]
 *   agentbox list
 *   agentbox remove <name>
 *
 * Packs install into ./.agentbox/packs (override with AGENTBOX_PACKS_DIR);
 * the runtime picks them up via box.loadHarnessPacks().
 */

function usage(): never {
  console.error(
    [
      'usage:',
      '  agentbox add <git-url|local-dir> [--name <name>] [--force]',
      '  agentbox list',
      '  agentbox remove <name>',
    ].join('\n'),
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const packsDir = process.env.AGENTBOX_PACKS_DIR ?? path.join('.agentbox', 'packs');
  const manager = new PackManager(packsDir);
  const [command, ...rest] = process.argv.slice(2);

  if (command === 'add') {
    const positional = rest.filter((a) => !a.startsWith('--'));
    const source = positional[0];
    if (!source) usage();
    const nameAt = rest.indexOf('--name');
    const pack = await manager.install(source, {
      name: nameAt >= 0 ? rest[nameAt + 1] : undefined,
      force: rest.includes('--force'),
    });
    console.log(`installed pack "${pack.name}" -> ${pack.dir}`);
    return;
  }

  if (command === 'list') {
    const packs = await manager.harnesses();
    if (packs.length === 0) {
      console.log(`no packs installed in ${packsDir}`);
      return;
    }
    for (const { pack, specs } of packs) {
      const version = pack.version ? `@${pack.version}` : '';
      console.log(`${pack.name}${version}${pack.description ? ` — ${pack.description}` : ''}`);
      for (const spec of specs) {
        console.log(`  ${spec.name} (${spec.backend})${spec.description ? ` — ${spec.description}` : ''}`);
      }
    }
    return;
  }

  if (command === 'remove') {
    const name = rest[0];
    if (!name) usage();
    const removed = await manager.remove(name);
    console.log(removed ? `removed pack "${name}"` : `pack "${name}" is not installed`);
    if (!removed) process.exit(1);
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
