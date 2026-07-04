import type { DriverContext, RunEvent } from '../types.js';
import { CliDriver, type CliInvocation, type CliParseState } from './cli.js';

/**
 * Adapter for Codex CLI (`codex exec --json`). Access outside the workspace is
 * blocked with --sandbox workspace-write; warm resume maps to `codex exec resume`.
 * codex has no per-tool allowlist, so isolation is tuned at the sandbox-mode level only.
 */
export class CodexDriver extends CliDriver {
  readonly backend = 'codex' as const;

  protected invocation(ctx: DriverContext): CliInvocation {
    const { harness } = ctx;
    const sandboxMode = (harness.driverOptions?.sandboxMode as string) ?? 'workspace-write';
    const args = ['exec'];
    if (ctx.state.resumeId) {
      // `exec resume` has no --cd/--sandbox flags; the spawn cwd (workspace
      // root) matches the recorded session cwd and the sandbox mode rides on
      // a config override instead.
      args.push('resume', ctx.state.resumeId, '--json', '--skip-git-repo-check');
      args.push('-c', `sandbox_mode=${JSON.stringify(sandboxMode)}`);
    } else {
      args.push('--json', '--skip-git-repo-check', '--cd', ctx.sandbox.root, '--sandbox', sandboxMode);
    }
    if (harness.model) args.push('--model', harness.model);
    // Declared MCP servers map to codex config overrides (TOML via -c).
    for (const [name, server] of Object.entries(harness.tools?.mcpServers ?? {})) {
      args.push('-c', `mcp_servers.${name}.command=${JSON.stringify(server.command)}`);
      if (server.args?.length) {
        args.push('-c', `mcp_servers.${name}.args=${JSON.stringify(server.args)}`);
      }
      if (server.env && Object.keys(server.env).length > 0) {
        const table = Object.entries(server.env)
          .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
          .join(', ');
        args.push('-c', `mcp_servers.${name}.env={ ${table} }`);
      }
    }
    // codex exec has no system prompt flag, so prepend it to the prompt.
    const prompt = harness.systemPrompt ? `${harness.systemPrompt}\n\n${ctx.prompt}` : ctx.prompt;
    args.push(prompt);
    const command = (harness.driverOptions?.command as string) ?? 'codex';
    return { command, args };
  }

  protected onLine(line: string, parse: CliParseState, ctx: DriverContext, emit: (event: RunEvent) => void): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    const msg = JSON.parse(trimmed) as Record<string, any>;

    if (msg.type === 'thread.started' && typeof msg.thread_id === 'string') {
      ctx.state.resumeId = msg.thread_id;
      return;
    }
    if (msg.type === 'error') {
      parse.error = String(msg.message ?? 'codex reported an error');
      return;
    }
    if (msg.type === 'turn.failed') {
      parse.error = String(msg.error?.message ?? 'codex turn failed');
      return;
    }
    if (msg.type !== 'item.completed' || !msg.item) return;

    const item = msg.item as Record<string, any>;
    switch (item.item_type ?? item.type) {
      case 'agent_message':
        if (typeof item.text === 'string') {
          parse.finalText = item.text;
          emit({ type: 'agent:message', text: item.text });
        }
        break;
      case 'reasoning':
        if (typeof item.text === 'string') emit({ type: 'agent:thinking', text: item.text });
        break;
      case 'command_execution':
        emit({ type: 'tool:call', name: 'shell', input: item.command });
        emit({ type: 'tool:result', name: 'shell', ok: item.exit_code === 0, detail: `exit ${item.exit_code}` });
        break;
      case 'file_change':
        emit({ type: 'tool:call', name: 'apply_patch', input: item.changes });
        break;
      default:
        break;
    }
  }
}
