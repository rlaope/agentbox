import type { DriverContext, RunEvent } from '../types.js';
import { CliDriver, type CliInvocation, type CliParseState } from './cli.js';

/**
 * Adapter for pi (badlogic/pi-mono), verified against pi's CLI surface:
 * `-p/--print` one-shot mode, `--append-system-prompt`, `--tools` allowlist
 * (`--no-tools` when the harness allows nothing), `--model`/`--provider`,
 * and warm resume via a workspace-local `--session-dir` with `--continue`.
 * Custom tools register through pi extensions: harness
 * driverOptions.extensions / driverOptions.skills become `-e` / `--skill`
 * flags. Output is treated as plain text.
 */
export class PiDriver extends CliDriver {
  readonly backend = 'pi' as const;

  protected invocation(ctx: DriverContext): CliInvocation {
    const { harness } = ctx;
    const command = (harness.driverOptions?.command as string) ?? 'pi';
    const args = ['-p'];
    if (harness.model) args.push('--model', harness.model);
    if (harness.driverOptions?.provider) args.push('--provider', String(harness.driverOptions.provider));
    if (harness.systemPrompt) args.push('--append-system-prompt', harness.systemPrompt);
    if (harness.tools?.allow) {
      if (harness.tools.allow.length > 0) args.push('--tools', harness.tools.allow.join(','));
      else args.push('--no-tools');
    }
    for (const extension of (harness.driverOptions?.extensions as string[]) ?? []) {
      args.push('-e', extension);
    }
    for (const skill of (harness.driverOptions?.skills as string[]) ?? []) {
      args.push('--skill', skill);
    }
    // Sessions live inside the workspace, so resume state follows the
    // session (and its container mounts) instead of the host home.
    args.push('--session-dir', '.agentbox-home/pi-sessions');
    if (ctx.state.resumeId) args.push('--continue');
    args.push(ctx.prompt);
    return { command, args };
  }

  protected onLine(line: string, parse: CliParseState, ctx: DriverContext, emit: (event: RunEvent) => void): void {
    if (!line.trim()) return;
    // Any completed run leaves a session behind; later runs continue it.
    ctx.state.resumeId = 'workspace-session';
    emit({ type: 'agent:message', text: line });
    parse.finalText = parse.finalText ? `${parse.finalText}\n${line}` : line;
  }
}
