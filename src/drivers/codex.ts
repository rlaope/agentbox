import type { DriverContext, RunEvent } from '../types.js';
import { CliDriver, type CliInvocation, type CliParseState } from './cli.js';

/**
 * Codex CLI(`codex exec --json`) 어댑터. 워크스페이스 밖 접근은
 * --sandbox workspace-write로 차단하고, warm resume은 `codex exec resume`으로 매핑한다.
 * codex는 tool 단위 allowlist가 없어 격리는 sandbox 모드 단위로만 조절된다.
 */
export class CodexDriver extends CliDriver {
  readonly backend = 'codex' as const;

  protected invocation(ctx: DriverContext): CliInvocation {
    const { harness } = ctx;
    const args = ['exec'];
    if (ctx.state.resumeId) args.push('resume', ctx.state.resumeId);
    args.push('--json', '--skip-git-repo-check', '--cd', ctx.sandbox.root);
    args.push('--sandbox', (harness.driverOptions?.sandboxMode as string) ?? 'workspace-write');
    if (harness.model) args.push('--model', harness.model);
    // codex exec에는 시스템 프롬프트 플래그가 없어 프롬프트 앞에 붙인다.
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
