import type { DriverContext, RunEvent } from '../types.js';
import { CliDriver, type CliInvocation, type CliParseState } from './cli.js';

/**
 * Adapter for pi (badlogic/pi-mono). The default is a one-shot
 * `pi -p "<prompt>"` invocation; override the call shape via
 * driverOptions.command / driverOptions.args to match the deployed pi
 * version. Output is treated as plain text.
 */
export class PiDriver extends CliDriver {
  readonly backend = 'pi' as const;

  protected invocation(ctx: DriverContext): CliInvocation {
    const { harness } = ctx;
    const command = (harness.driverOptions?.command as string) ?? 'pi';
    const baseArgs = (harness.driverOptions?.args as string[]) ?? ['-p'];
    const prompt = harness.systemPrompt ? `${harness.systemPrompt}\n\n${ctx.prompt}` : ctx.prompt;
    return { command, args: [...baseArgs, prompt] };
  }

  protected onLine(line: string, parse: CliParseState, _ctx: DriverContext, emit: (event: RunEvent) => void): void {
    if (!line.trim()) return;
    emit({ type: 'agent:message', text: line });
    parse.finalText = parse.finalText ? `${parse.finalText}\n${line}` : line;
  }
}
