import type { DriverContext, RunEvent } from '../types.js';
import { CliDriver, type CliInvocation, type CliParseState } from './cli.js';

/**
 * pi(badlogic/pi-mono) 어댑터. 기본값은 `pi -p "<prompt>"` 단발 실행이며
 * 배포 환경의 pi 버전에 맞춰 driverOptions.command / driverOptions.args로
 * 호출 형태를 오버라이드한다. 출력은 플레인 텍스트로 취급한다.
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
