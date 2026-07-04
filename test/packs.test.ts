import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agentbox } from '../src/agentbox.js';
import { PackManager, isGitSource } from '../src/packs/manager.js';

const HARNESS_MD = (name: string) => `---\nname: ${name}\nbackend: pi\n---\nDo the ${name} task.\n`;

async function makePackSource(opts: { manifest?: object; inSubdir?: boolean; harnessNames?: string[] }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-pack-src-'));
  const harnessDir = opts.inSubdir ? path.join(dir, 'harnesses') : dir;
  await fs.mkdir(harnessDir, { recursive: true });
  for (const name of opts.harnessNames ?? ['demo-task']) {
    await fs.writeFile(path.join(harnessDir, `${name}.md`), HARNESS_MD(name));
  }
  if (opts.manifest) {
    await fs.writeFile(path.join(dir, 'agentbox-pack.json'), JSON.stringify(opts.manifest));
  }
  return dir;
}

async function makeManager() {
  const packsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-packs-'));
  return { manager: new PackManager(packsDir), packsDir };
}

test('detects git sources vs local paths', () => {
  assert.ok(isGitSource('https://github.com/rlaope/deck-pack'));
  assert.ok(isGitSource('git@github.com:rlaope/deck-pack.git'));
  assert.ok(isGitSource('https://example.com/repo.git'));
  assert.ok(!isGitSource('./local/pack'));
  assert.ok(!isGitSource('/abs/path/pack'));
});

test('installs a local pack by copying and resolves the conventional harnesses/ dir', async () => {
  const source = await makePackSource({ inSubdir: true, harnessNames: ['deck', 'report'] });
  const { manager } = await makeManager();

  const pack = await manager.install(source, { name: 'office' });
  assert.equal(pack.name, 'office');
  assert.equal(path.basename(pack.harnessDir), 'harnesses');

  // Copy, not link: mutating the source must not affect the installed pack.
  await fs.rm(source, { recursive: true, force: true });
  const listed = await manager.harnesses();
  assert.deepEqual(listed[0].specs.map((s) => s.name).sort(), ['deck', 'report']);
});

test('manifest name, description, and harnesses dir are honored', async () => {
  const source = await makePackSource({
    manifest: { name: 'named-pack', version: '1.2.0', description: 'demo pack', harnesses: '.' },
  });
  const { manager } = await makeManager();
  const pack = await manager.install(source);
  const listed = await manager.list();
  assert.equal(listed[0].name, 'named-pack');
  assert.equal(listed[0].version, '1.2.0');
  assert.equal(listed[0].source, source);
  assert.equal(pack.harnessDir, pack.dir);
});

test('duplicate install fails without force and succeeds with it', async () => {
  const source = await makePackSource({});
  const { manager } = await makeManager();
  await manager.install(source, { name: 'p' });
  await assert.rejects(manager.install(source, { name: 'p' }), /already installed/);
  await manager.install(source, { name: 'p', force: true });
});

test('a pack with a broken harness file is rejected at install time', async () => {
  const source = await makePackSource({});
  await fs.writeFile(path.join(source, 'broken.md'), '---\nname: broken\ntools: [oops\n---\n');
  const { manager } = await makeManager();
  await assert.rejects(manager.install(source, { name: 'p' }), /broken\.md/);
});

test('remove deletes an installed pack and reports unknown names', async () => {
  const source = await makePackSource({});
  const { manager } = await makeManager();
  await manager.install(source, { name: 'p' });
  assert.equal(await manager.remove('p'), true);
  assert.equal(await manager.remove('p'), false);
  assert.deepEqual(await manager.list(), []);
});

test('Agentbox.loadHarnessPacks registers every installed pack', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-packs-box-'));
  const manager = new PackManager(path.join(baseDir, 'packs'));
  await manager.install(await makePackSource({ harnessNames: ['deck'] }), { name: 'a-office' });
  await manager.install(await makePackSource({ harnessNames: ['scraper'] }), { name: 'b-web' });

  const box = new Agentbox({ baseDir });
  const packs = await box.loadHarnessPacks();
  assert.deepEqual(packs.map((p) => p.name), ['a-office', 'b-web']);
  assert.deepEqual(box.harnesses().map((h) => h.name).sort(), ['deck', 'scraper']);
  await box.close();
});
