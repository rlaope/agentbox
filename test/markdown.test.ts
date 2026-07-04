import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agentbox } from '../src/agentbox.js';
import { harnessFromMarkdown, loadHarnessFile } from '../src/harness/markdown.js';

const FULL_EXAMPLE = `---
name: ppt-generate
description: Generate a deck
backend: claude
model: claude-sonnet-5
tools:
  allow: [Read, Write, "Bash(node:*)"]
  deny: [WebSearch]
artifacts: [out/**/*.pptx]
limits: { maxTurns: 30, timeoutMs: 480000 }
workspace:
  seedFiles:
    package.json: "{ \\"private\\": true }"
driverOptions: { command: claude-custom }
---
You are a presentation-generation harness.
Produce exactly one file: out/deck.pptx.
`;

test('frontmatter maps 1:1 onto HarnessSpec, body becomes systemPrompt', () => {
  const spec = harnessFromMarkdown(FULL_EXAMPLE);
  assert.equal(spec.name, 'ppt-generate');
  assert.equal(spec.backend, 'claude');
  assert.equal(spec.model, 'claude-sonnet-5');
  assert.deepEqual(spec.tools, { allow: ['Read', 'Write', 'Bash(node:*)'], deny: ['WebSearch'] });
  assert.deepEqual(spec.artifacts, { globs: ['out/**/*.pptx'] });
  assert.deepEqual(spec.limits, { maxTurns: 30, timeoutMs: 480000 });
  assert.deepEqual(spec.workspace, { seedFiles: { 'package.json': '{ "private": true }' } });
  assert.deepEqual(spec.driverOptions, { command: 'claude-custom' });
  assert.match(spec.systemPrompt ?? '', /^You are a presentation-generation harness\./);
});

test('artifacts accepts both the glob-array shorthand and { globs }', () => {
  const short = harnessFromMarkdown('---\nname: a\nbackend: pi\nartifacts: [out/*.md]\n---\n');
  const long = harnessFromMarkdown('---\nname: a\nbackend: pi\nartifacts: { globs: [out/*.md] }\n---\n');
  assert.deepEqual(short.artifacts, long.artifacts);
});

test('missing backend fails with the source path in the message', () => {
  assert.throws(() => harnessFromMarkdown('---\nname: a\n---\n', { source: 'x/a.md' }), /x\/a\.md.*backend/);
});

test('missing frontmatter block is rejected', () => {
  assert.throws(() => harnessFromMarkdown('just a document'), /frontmatter/);
});

test('name defaults to the file basename', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-md-'));
  const file = path.join(dir, 'doc-generate.md');
  await fs.writeFile(file, '---\nbackend: pi\n---\nWrite the doc.\n');
  const spec = await loadHarnessFile(file);
  assert.equal(spec.name, 'doc-generate');
  await fs.rm(dir, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(check(), `condition not met within ${timeoutMs}ms`);
}

function demoMd(description: string): string {
  return `---\nname: demo\ndescription: ${description}\nbackend: pi\n---\nDo the demo task.\n`;
}

test('loadHarnessDir registers markdown harnesses and hot-reloads with watch', async () => {
  const harnessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-watch-'));
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-base-'));
  const file = path.join(harnessDir, 'demo.md');
  await fs.writeFile(file, demoMd('v1'));

  const box = new Agentbox({ baseDir });
  const loaded = await box.loadHarnessDir(harnessDir, { watch: true });
  assert.deepEqual(loaded.map((h) => h.name), ['demo']);
  assert.equal(box.harnesses()[0].description, 'v1');

  await fs.writeFile(file, demoMd('v2'));
  await waitFor(() => box.harnesses().find((h) => h.name === 'demo')?.description === 'v2');

  // A broken save must keep the previous registration in place.
  await fs.writeFile(file, '---\nname: demo\nbackend: pi\ntools: [broken\n---\n');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(box.harnesses().find((h) => h.name === 'demo')?.description, 'v2');

  await fs.rm(file);
  await waitFor(() => !box.harnesses().some((h) => h.name === 'demo'));

  await box.close();
  await fs.rm(harnessDir, { recursive: true, force: true });
});
