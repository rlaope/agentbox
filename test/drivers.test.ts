import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ClaudeDriver } from '../src/drivers/claude.js';
import type { CliInvocation } from '../src/drivers/cli.js';
import { LocalSandboxProvider } from '../src/sandbox/local.js';
import { ContainerSandboxProvider } from '../src/sandbox/container.js';
import type { DriverContext, HarnessSpec } from '../src/types.js';

class InspectableClaudeDriver extends ClaudeDriver {
  buildInvocation(ctx: DriverContext): CliInvocation {
    return this.invocation(ctx);
  }

  prepare(ctx: DriverContext): Promise<void> {
    return this.beforeRun(ctx);
  }
}

async function makeContext(harness: Partial<HarnessSpec>): Promise<DriverContext> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-driver-'));
  const sandbox = await new LocalSandboxProvider(baseDir).create('s1');
  return {
    runId: 'r1',
    harness: { name: 'task', backend: 'claude', ...harness },
    prompt: 'do it',
    sandbox,
    state: {},
    signal: new AbortController().signal,
  };
}

test('declared MCP servers are written to the workspace and wired via --mcp-config', async () => {
  const driver = new InspectableClaudeDriver();
  const ctx = await makeContext({
    tools: {
      allow: ['Read', 'mcp__search'],
      mcpServers: { search: { command: 'search-mcp', args: ['--fast'] } },
    },
  });

  await driver.prepare(ctx);
  const config = JSON.parse(await fs.readFile(path.join(ctx.sandbox.root, '.agentbox.mcp.json'), 'utf8'));
  assert.deepEqual(config.mcpServers.search, { command: 'search-mcp', args: ['--fast'] });

  const inv = driver.buildInvocation(ctx);
  const at = inv.args.indexOf('--mcp-config');
  assert.ok(at >= 0);
  assert.equal(inv.args[at + 1], '.agentbox.mcp.json');
  assert.ok(inv.args.includes('--strict-mcp-config'));
  await ctx.sandbox.destroy();
});

test('no MCP flags are added when no servers are declared', async () => {
  const driver = new InspectableClaudeDriver();
  const ctx = await makeContext({ tools: { allow: ['Read'] } });
  await driver.prepare(ctx);
  const inv = driver.buildInvocation(ctx);
  assert.ok(!inv.args.includes('--mcp-config'));
  await ctx.sandbox.destroy();
});

test('container sandbox forwards invocation-scoped env names with -e', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-driver-env-'));
  const sandbox = await new ContainerSandboxProvider(baseDir, { image: 'img' }).create('s1');
  const wrapped = sandbox.wrapCommand({ command: 'claude', args: ['-p', 'x'], env: { PPTX_LICENSE: 'k' } });
  const flags: string[] = [];
  wrapped.args.forEach((arg, i) => {
    if (arg === '-e') flags.push(wrapped.args[i + 1]);
  });
  assert.ok(flags.includes('PPTX_LICENSE'));
  await sandbox.destroy();
});
