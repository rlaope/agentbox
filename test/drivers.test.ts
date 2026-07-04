import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ClaudeDriver } from '../src/drivers/claude.js';
import { CodexDriver } from '../src/drivers/codex.js';
import { PiDriver } from '../src/drivers/pi.js';
import type { CliInvocation } from '../src/drivers/cli.js';
import { LocalSandboxProvider } from '../src/sandbox/local.js';
import { ContainerSandboxProvider } from '../src/sandbox/container.js';
import type { BackendSessionState, DriverContext, HarnessSpec } from '../src/types.js';

class InspectableClaudeDriver extends ClaudeDriver {
  buildInvocation(ctx: DriverContext): CliInvocation {
    return this.invocation(ctx);
  }

  prepare(ctx: DriverContext): Promise<void> {
    return this.beforeRun(ctx);
  }
}

class InspectableCodexDriver extends CodexDriver {
  buildInvocation(ctx: DriverContext): CliInvocation {
    return this.invocation(ctx);
  }
}

class InspectablePiDriver extends PiDriver {
  buildInvocation(ctx: DriverContext): CliInvocation {
    return this.invocation(ctx);
  }
}

async function makeContext(harness: Partial<HarnessSpec>, state: BackendSessionState = {}): Promise<DriverContext> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbox-driver-'));
  const sandbox = await new LocalSandboxProvider(baseDir).create('s1');
  return {
    runId: 'r1',
    harness: { name: 'task', backend: 'claude', ...harness },
    prompt: 'do it',
    sandbox,
    state,
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

test('pi maps tool policy, system prompt, and extensions to verified CLI flags', async () => {
  const driver = new InspectablePiDriver();
  const ctx = await makeContext({
    backend: 'pi',
    model: 'gemini-2.5-pro',
    systemPrompt: 'Write docs.',
    tools: { allow: ['read', 'write'] },
    driverOptions: { provider: 'google', extensions: ['./tools/chart.ts'] },
  });
  const inv = driver.buildInvocation(ctx);
  assert.equal(inv.command, 'pi');
  assert.deepEqual(inv.args.slice(0, 1), ['-p']);
  assert.ok(inv.args.includes('--append-system-prompt'));
  const toolsAt = inv.args.indexOf('--tools');
  assert.equal(inv.args[toolsAt + 1], 'read,write');
  assert.deepEqual(inv.args.slice(inv.args.indexOf('-e'), inv.args.indexOf('-e') + 2), ['-e', './tools/chart.ts']);
  assert.ok(inv.args.includes('--session-dir'));
  assert.ok(!inv.args.includes('--continue'));
  await ctx.sandbox.destroy();
});

test('pi uses --no-tools for an empty allowlist and --continue on warm sessions', async () => {
  const driver = new InspectablePiDriver();
  const ctx = await makeContext({ backend: 'pi', tools: { allow: [] } }, { resumeId: 'workspace-session' });
  const inv = driver.buildInvocation(ctx);
  assert.ok(inv.args.includes('--no-tools'));
  assert.ok(inv.args.includes('--continue'));
  await ctx.sandbox.destroy();
});

test('codex maps MCP servers to -c config overrides', async () => {
  const driver = new InspectableCodexDriver();
  const ctx = await makeContext({
    backend: 'codex',
    tools: { mcpServers: { search: { command: 'search-mcp', args: ['--fast'], env: { KEY: 'v' } } } },
  });
  const inv = driver.buildInvocation(ctx);
  const configs = inv.args.filter((_, i) => inv.args[i - 1] === '-c');
  assert.ok(configs.includes('mcp_servers.search.command="search-mcp"'));
  assert.ok(configs.includes('mcp_servers.search.args=["--fast"]'));
  assert.ok(configs.includes('mcp_servers.search.env={ KEY = "v" }'));
  await ctx.sandbox.destroy();
});

test('codex resume drops exec-only flags and keeps the sandbox as a config override', async () => {
  const driver = new InspectableCodexDriver();
  const ctx = await makeContext({ backend: 'codex' }, { resumeId: 'thread-1' });
  const inv = driver.buildInvocation(ctx);
  assert.deepEqual(inv.args.slice(0, 3), ['exec', 'resume', 'thread-1']);
  assert.ok(!inv.args.includes('--cd'));
  assert.ok(!inv.args.includes('--sandbox'));
  assert.ok(inv.args.includes('sandbox_mode="workspace-write"'));
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
