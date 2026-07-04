import type { DriverContext, RunEvent } from '../types.js';
import { CliDriver, type CliInvocation, type CliParseState } from './cli.js';

/**
 * Claude Code headless(`claude -p --output-format stream-json`) 어댑터.
 * tool 최소화는 --allowedTools/--disallowedTools로, warm resume은 --resume으로 매핑한다.
 */
export class ClaudeDriver extends CliDriver {
  readonly backend = 'claude' as const;

  protected invocation(ctx: DriverContext): CliInvocation {
    const { harness } = ctx;
    const args = ['-p', ctx.prompt, '--output-format', 'stream-json', '--verbose'];
    if (harness.model) args.push('--model', harness.model);
    if (harness.systemPrompt) args.push('--append-system-prompt', harness.systemPrompt);
    if (harness.tools?.allow?.length) args.push('--allowedTools', harness.tools.allow.join(','));
    if (harness.tools?.deny?.length) args.push('--disallowedTools', harness.tools.deny.join(','));
    if (harness.limits?.maxTurns) args.push('--max-turns', String(harness.limits.maxTurns));
    if (ctx.state.resumeId) args.push('--resume', ctx.state.resumeId);
    const command = (ctx.harness.driverOptions?.command as string) ?? 'claude';
    return { command, args };
  }

  protected onLine(line: string, parse: CliParseState, ctx: DriverContext, emit: (event: RunEvent) => void): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    const msg = JSON.parse(trimmed) as Record<string, any>;

    if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.session_id === 'string') {
      ctx.state.resumeId = msg.session_id;
    } else if (msg.type === 'assistant') {
      const blocks: any[] = msg.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          emit({ type: 'agent:message', text: block.text });
        } else if (block.type === 'thinking' && block.thinking) {
          emit({ type: 'agent:thinking', text: block.thinking });
        } else if (block.type === 'tool_use') {
          emit({ type: 'tool:call', name: block.name, input: block.input });
        }
      }
    } else if (msg.type === 'user') {
      const blocks: any[] = msg.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          emit({ type: 'tool:result', name: String(block.tool_use_id ?? 'tool'), ok: !block.is_error });
        }
      }
    } else if (msg.type === 'result') {
      if (typeof msg.session_id === 'string') ctx.state.resumeId = msg.session_id;
      if (typeof msg.result === 'string') parse.finalText = msg.result;
      if (msg.is_error) parse.error = typeof msg.result === 'string' ? msg.result : 'claude reported an error';
    }
  }
}
