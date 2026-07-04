import { defineHarness } from '../src/index.js';

/**
 * Code-level harness example — the escape hatch for anything markdown cannot
 * express (custom drivers, dynamic tool policies, conditional seeding).
 * The common case lives in ./harnesses/*.md instead.
 */
export const bashGenerate = defineHarness({
  name: 'bash-generate',
  description: 'Generate a reviewed bash script for a described task',
  backend: 'codex',
  systemPrompt: [
    'Write a bash script that performs the requested automation task to out/script.sh.',
    'Include `set -euo pipefail`, self-review the script shellcheck-style, then finish.',
  ].join('\n'),
  artifacts: { globs: ['out/*.sh'] },
  // Execution-based verification: the generated script must at least parse.
  verify: { command: ['sh', '-n', 'out/script.sh'] },
  // Output guardrail: never ship a script that pipes a download into a shell.
  guardrails: {
    output: [
      (ctx) =>
        /curl[^\n]*\|\s*(sh|bash)/.test(ctx.finalText ?? '')
          ? { allowed: false, reason: 'refusing a curl|sh pattern in the output' }
          : { allowed: true },
    ],
  },
  limits: { timeoutMs: 4 * 60_000 },
});
