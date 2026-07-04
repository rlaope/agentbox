import { defineHarness } from '../src/index.js';

/**
 * 하네스 예제 3종. 같은 프레임워크 위에서 백엔드와 tool 표면만 바꿔
 * 서로 다른 SaaS 작업 프로파일을 만드는 방식을 보여준다.
 */

/** ppt 생성: claude 백엔드, 파일 조작 + node 실행만 허용해 tool 표면 최소화 */
export const pptGenerate = defineHarness({
  name: 'ppt-generate',
  description: 'Generate a .pptx deck from a user prompt',
  backend: 'claude',
  systemPrompt: [
    '너는 프레젠테이션 생성 하네스다.',
    '워크스페이스 안에서 pptxgenjs를 사용하는 node 스크립트를 작성/실행해서',
    'out/deck.pptx 파일 하나를 산출한다. 다른 파일 경로는 건드리지 않는다.',
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

/** bash 스크립트 생성: codex 백엔드, 파일 산출 중심 */
export const bashGenerate = defineHarness({
  name: 'bash-generate',
  description: 'Generate a reviewed bash script for a described task',
  backend: 'codex',
  systemPrompt: [
    '요청받은 자동화 작업을 수행하는 bash 스크립트를 out/script.sh로 작성한다.',
    'set -euo pipefail을 포함하고, 스크립트를 shellcheck 스타일로 스스로 점검한 뒤 마친다.',
  ].join('\n'),
  artifacts: { globs: ['out/*.sh'] },
  limits: { timeoutMs: 4 * 60_000 },
});

/** 문서 생성: pi 백엔드, 단발 실행 프로파일 */
export const docGenerate = defineHarness({
  name: 'doc-generate',
  description: 'Generate a markdown document from a prompt',
  backend: 'pi',
  systemPrompt: '요청 내용을 정리한 markdown 문서를 out/doc.md로 작성한다.',
  artifacts: { globs: ['out/*.md'] },
  limits: { timeoutMs: 3 * 60_000 },
});
