# agentbox

The AI Agent Framework — Sandboxed Multi-Agent Orchestration, High-Throughput Stateful Agent, Modular Agent Session Manager & Runtime.

SaaS 서버 안에서 coding agent(pi / codex / claude code)를 실행 엔진으로 운영하기 위한 프레임워크다. 유저 요청이 API로 들어오면 세션을 열어 하네스와 함께 작업하고 산출물을 반환한다. ppt 생성, 문서 생성, bash 스크립트 생성 같은 작업 유형별 프로파일을 하네스 하나로 선언한다.

```
유저 → SaaS 클라이언트 → API call → agentbox
        └ 세션 획득(재사용) → 하네스 실행(codex/claude/pi) → 산출물 반환
```

## 핵심 개념

- **Harness** — 작업 유형 하나의 실행 프로파일. 백엔드, tool allowlist, 워크스페이스 시드, 산출물 glob, 턴/시간 한도를 선언한다.
- **Session** — `(userId, goalId)` 단위. 워크스페이스와 백엔드 resume 상태를 소유하며, 같은 단위의 후속 요청은 데워진 세션을 재활용한다.
- **Sandbox** — 세션 파일 영역 격리. 기본은 프로세스 수준(local), 인터페이스 뒤로 container/microVM을 꽂는다.
- **Driver** — pi / codex / claude 어댑터. 하네스 선언을 백엔드 옵션으로 번역하고 출력을 공통 이벤트로 정규화한다.
- **FairScheduler** — 글로벌 동시 run 상한 + 유저 lane 라운드로빈으로 처리량과 공정성을 지킨다.

상세 설계는 [docs/DESIGN.md](docs/DESIGN.md)에 있다.

## 사용 예

```ts
import { Agentbox, defineHarness } from 'agentbox';

const pptGenerate = defineHarness({
  name: 'ppt-generate',
  backend: 'claude',
  systemPrompt: '워크스페이스 안에서 out/deck.pptx를 생성한다.',
  tools: { allow: ['Read', 'Write', 'Edit', 'Bash(node:*)'] },
  artifacts: { globs: ['out/**/*.pptx'] },
  limits: { maxTurns: 30, timeoutMs: 480_000 },
});

const box = new Agentbox({ maxConcurrentRuns: 8 });
box.register(pptGenerate);

const result = await box.run({
  session: { userId: 'u1', goalId: 'q2-deck' },
  harness: 'ppt-generate',
  prompt: '2분기 실적 요약 5장짜리 덱',
});
console.log(result.artifacts); // [{ path: 'out/deck.pptx', ... }]
```

HTTP 서버로 띄우려면:

```sh
npx tsx examples/server.ts
curl -N localhost:8787/v1/runs -d '{
  "session": { "userId": "u1", "goalId": "q2-deck" },
  "harness": "ppt-generate",
  "prompt": "2분기 실적 요약 덱"
}'
```

## 개발

```sh
npm install
npm run typecheck
npm test
```

## 상태

v0.1 — 설계 + 코어 골격. local 샌드박스, 3개 백엔드 드라이버, 세션 매니저, 공정 스케줄러, HTTP 파사드, 예제 하네스 3종이 포함된다. container provider와 pi tool 제어는 로드맵에 있다.
