import { defineHarness } from '../src/index.js';

/**
 * Three example harnesses. They show how the same framework produces
 * different SaaS task profiles by swapping only the backend and tool surface.
 */

/** PPT generation: claude backend, tool surface cut down to file ops + node execution */
export const pptGenerate = defineHarness({
  name: 'ppt-generate',
  description: 'Generate a .pptx deck from a user prompt',
  backend: 'claude',
  systemPrompt: [
    'You are a presentation-generation harness.',
    'Inside the workspace, write and run a node script that uses pptxgenjs',
    'to produce exactly one file: out/deck.pptx. Do not touch any other paths.',
  ].join('\n'),
  tools: {
    allow: ['Read', 'Write', 'Edit', 'Glob', 'Bash(node:*)', 'Bash(npm install:*)'],
  },
  workspace: {
    seedFiles: {
      'package.json': JSON.stringify({ name: 'deck', private: true, dependencies: { pptxgenjs: '^3.12.0' } }, null, 2),
    },
  },
  artifacts: { globs: ['out/**/*.pptx'] },
  limits: { maxTurns: 30, timeoutMs: 8 * 60_000 },
});

/** Bash script generation: codex backend, file-output oriented */
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

/** Document generation: pi backend, one-shot profile */
export const docGenerate = defineHarness({
  name: 'doc-generate',
  description: 'Generate a markdown document from a prompt',
  backend: 'pi',
  systemPrompt: 'Write a markdown document covering the request to out/doc.md.',
  artifacts: { globs: ['out/*.md'] },
  limits: { timeoutMs: 3 * 60_000 },
});
