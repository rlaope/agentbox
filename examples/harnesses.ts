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
  limits: { timeoutMs: 4 * 60_000 },
});
