import type { Guardrail, GuardrailContext, GuardrailVerdict } from '../types.js';

/**
 * Runs guardrails in order and returns the first block, or an allow if none
 * object. A throwing guardrail is treated as a block (fail closed) so a broken
 * check can't silently wave content through.
 */
export async function runGuardrails(guards: Guardrail[] | undefined, ctx: GuardrailContext): Promise<GuardrailVerdict> {
  for (const guard of guards ?? []) {
    let verdict: GuardrailVerdict;
    try {
      verdict = await guard(ctx);
    } catch (err) {
      return { allowed: false, reason: `guardrail threw: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!verdict.allowed) return verdict;
  }
  return { allowed: true };
}

/** Built-in: block when any pattern matches the output text. */
export function denyOutputPatterns(patterns: RegExp[]): Guardrail {
  return (ctx) => {
    const text = ctx.finalText ?? '';
    // `.test` mutates `lastIndex` on /g and /y patterns, which would make a
    // reused guardrail alternate block/allow across runs — a fail-open for a
    // security check. Reset before each test so matching is stateless.
    const hit = patterns.find((p) => {
      p.lastIndex = 0;
      return p.test(text);
    });
    return hit ? { allowed: false, reason: `output matched blocked pattern ${hit}` } : { allowed: true };
  };
}
