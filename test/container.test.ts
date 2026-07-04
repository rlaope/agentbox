import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ContainerSandboxProvider } from '../src/sandbox/container.js';

async function makeSandbox(opts: ConstructorParameters<typeof ContainerSandboxProvider>[1]) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-container-'));
  const provider = new ContainerSandboxProvider(baseDir, opts);
  return provider.create('s1');
}

test('wrapCommand wraps the invocation in docker run with the workspace mounted', async () => {
  const sandbox = await makeSandbox({ image: 'agentbox-runner:latest' });
  const wrapped = sandbox.wrapCommand({ command: 'claude', args: ['-p', 'make a deck'] });

  assert.equal(wrapped.command, 'docker');
  assert.deepEqual(wrapped.args.slice(0, 2), ['run', '--rm']);
  assert.ok(wrapped.args.includes(`${sandbox.root}:/workspace`));
  assert.deepEqual(wrapped.args.slice(wrapped.args.indexOf('-w'), wrapped.args.indexOf('-w') + 2), ['-w', '/workspace']);
  // The original invocation comes last: image, then command and args untouched.
  assert.deepEqual(wrapped.args.slice(-4), ['agentbox-runner:latest', 'claude', '-p', 'make a deck']);
  await sandbox.destroy();
});

test('persistHome mounts a per-session home so resume state survives ephemeral containers', async () => {
  const sandbox = await makeSandbox({ image: 'img' });
  const wrapped = sandbox.wrapCommand({ command: 'codex', args: ['exec'] });

  assert.ok(wrapped.args.includes(`${path.join(sandbox.root, '.agentbox-home')}:/agentbox-home`));
  assert.ok(wrapped.args.includes('HOME=/agentbox-home'));
  const stat = await fs.stat(path.join(sandbox.root, '.agentbox-home'));
  assert.ok(stat.isDirectory());
  await sandbox.destroy();
});

test('options control runtime, network, env passthrough, and extra args', async () => {
  const sandbox = await makeSandbox({
    image: 'img',
    runtime: 'podman',
    network: 'none',
    envPassthrough: ['MY_KEY'],
    extraArgs: ['--memory', '512m'],
    persistHome: false,
  });
  const wrapped = sandbox.wrapCommand({ command: 'pi', args: ['-p', 'x'] });

  assert.equal(wrapped.command, 'podman');
  assert.deepEqual(wrapped.args.slice(wrapped.args.indexOf('--network'), wrapped.args.indexOf('--network') + 2), ['--network', 'none']);
  assert.ok(wrapped.args.includes('MY_KEY'));
  assert.ok(wrapped.args.includes('--memory'));
  assert.ok(!wrapped.args.some((a) => a.includes('.agentbox-home')));
  await sandbox.destroy();
});

test('artifact collection skips the mounted home directory', async () => {
  const sandbox = await makeSandbox({ image: 'img' });
  await sandbox.writeFile('out/result.md', 'ok');
  await sandbox.writeFile('.agentbox-home/state.md', 'internal');
  const artifacts = await sandbox.collect(['**/*.md']);
  assert.deepEqual(artifacts.map((a) => a.path), ['out/result.md']);
  await sandbox.destroy();
});
