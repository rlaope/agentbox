# agentbox 설계 문서

The AI Agent Framework — Sandboxed Multi-Agent Orchestration, High-Throughput Stateful Agent, Modular Agent Session Manager & Runtime.

## 1. 배경과 문제

SaaS 서비스가 coding agent(codex, claude code, pi)를 서버 내부의 실행 엔진으로 쓰는 패턴이 늘고 있다. 예: ppt 생성 SaaS에서 유저가 프롬프트를 입력하면, 서버가 codex 세션을 열어 워크스페이스 안에서 스크립트를 작성·실행해 `.pptx`를 만들어 돌려준다. 문서 생성, 이미지 생성, bash 스크립트 생성도 같은 구조다.

이 구조를 실제 서비스로 운영하려면 네 가지 문제를 동시에 풀어야 한다.

1. **격리** — 서로 다른 유저/프로젝트의 파일 영역이 절대 섞이면 안 된다.
2. **처리량** — 동시에 다수의 요청·세션을 받아야 하고, 같은 작업 단위에 대한 후속 요청은 이미 데워진 세션을 재활용해야 한다.
3. **Tool 표면 최소화** — 범용 coding agent는 tool이 많을수록 느리고 위험하다. "ppt 생성"에는 파일 쓰기와 node 실행만 있으면 된다. 작업 유형별로 tool 표면을 선언적으로 잘라내야 한다.
4. **백엔드 교체 가능성** — pi / codex / claude 중 무엇으로도 같은 하네스를 돌릴 수 있어야 한다.

agentbox는 이 네 가지를 코어 계약으로 삼는 프레임워크다.

## 2. 개념 모델

| 개념 | 정의 |
|---|---|
| **Harness** | 작업 유형 하나의 실행 프로파일. 백엔드 + 모델 + 시스템 프롬프트 + tool 정책 + 워크스페이스 시드 + 산출물 계약 + 한도(턴/시간)를 선언한다. |
| **Session** | `(userId, goalId)` 1쌍. 워크스페이스 1개와 백엔드별 resume 상태를 소유한다. 요청마다 만들지 않는다. |
| **Run** | 세션 안에서 하네스로 프롬프트 1개를 처리하는 실행 1회. |
| **Sandbox** | 세션 워크스페이스의 격리 구현. `local`(프로세스 수준)이 기본, 인터페이스 뒤로 container/microVM을 꽂는다. |
| **Driver** | agent 백엔드 어댑터. 하네스 선언을 백엔드 네이티브 옵션으로 번역하고 출력 스트림을 공통 이벤트로 정규화한다. |
| **Artifact** | run 종료 후 워크스페이스에서 glob으로 수집되는 산출물 파일. |

## 3. 아키텍처

```
                    ┌──────────────────────────────────────────────┐
 SaaS client        │ agentbox                                     │
   │  POST /v1/runs │                                              │
   ▼                │  ┌───────────┐   ┌──────────────────────┐    │
 HTTP facade ───────┼─▶│ Harness   │   │ FairScheduler        │    │
 (SSE stream)       │  │ Registry  │   │ 글로벌 동시성 상한    │    │
                    │  └───────────┘   │ + user lane RR       │    │
                    │        │         └──────────┬───────────┘    │
                    │        ▼                    ▼                │
                    │  ┌──────────────────────────────────────┐    │
                    │  │ SessionManager                       │    │
                    │  │  (userId, goalId) → Session          │    │
                    │  │  세션 내 run 직렬화, idle TTL 회수    │    │
                    │  └──────┬───────────────────────────────┘    │
                    │         ▼                                    │
                    │  ┌────────────┐      ┌─────────────────┐     │
                    │  │ Sandbox    │◀────▶│ Driver          │     │
                    │  │ local /    │ cwd  │ pi | codex |    │     │
                    │  │ container  │      │ claude          │     │
                    │  └────────────┘      └─────────────────┘     │
                    │         │                                    │
                    │         ▼ artifact collect (globs)           │
                    └──────────────────────────────────────────────┘
```

요청 1건의 수명: `POST /v1/runs` → 하네스 조회 → 세션 획득(있으면 재사용) → 스케줄러 대기열 → 세션 내 직렬 실행 슬롯 → 드라이버가 CLI spawn (cwd=워크스페이스) → 출력 스트림을 RunEvent로 정규화해 SSE로 중계 → 종료 후 artifact glob 수집 → `RunResult` 반환.

## 4. 격리 모델

### 세션 단위 격리
요청당 컨테이너는 과하다는 판단에 따라 격리 단위는 **세션 = 유저 1명의 작업 목표 1개**다. 세션마다 전용 워크스페이스 디렉토리가 생기고, 드라이버는 CLI를 반드시 그 디렉토리를 cwd로 spawn한다.

- `LocalSandbox.writeFile`은 경로를 resolve해 루트 밖 탈출(`../`)을 거부한다.
- 자식 프로세스 환경변수는 allowlist(`PATH`, `HOME`, API 키 등)만 통과시켜 서버 프로세스의 비밀이 워크스페이스로 새는 표면을 줄인다.
- codex는 `--sandbox workspace-write`, claude는 tool allowlist로 워크스페이스 밖 쓰기를 백엔드 수준에서도 한 번 더 막는다.

### 격리 백엔드 추상화
`SandboxProvider` 인터페이스(`create(id, spec) → Sandbox`)가 격리 구현을 숨긴다. v0.1은 `local`(같은 호스트, 디렉토리 격리)만 제공한다. 신뢰 경계가 필요해지면 같은 인터페이스로 container provider(세션당 볼륨 + 공유 실행 컨테이너 풀)나 microVM provider를 꽂고, 하네스가 `sandbox: 'container'`로 선택한다. 세션당 컨테이너 상시 점유가 아니라 **워크스페이스(볼륨)는 세션 소유, 실행 환경은 풀에서 대여**하는 방향이 로드맵이다.

## 5. 처리량 전략

1. **세션 재활용 (stateful warm session)** — 같은 `(userId, goalId)` 요청은 같은 세션으로 라우팅된다. 워크스페이스가 유지되므로 의존성 설치·중간 산출물이 재사용되고, 드라이버는 백엔드 resume id(claude `--resume`, codex `exec resume`)를 세션에 저장해 대화 컨텍스트 재구축 비용을 없앤다.
2. **글로벌 동시성 상한 + 공정성** — `FairScheduler`가 서버 전체 동시 run 수를 상한(기본 4)으로 묶고, userId lane 라운드로빈으로 한 유저의 폭주가 다른 유저를 굶기지 못하게 한다.
3. **세션 내 직렬화** — 같은 세션에 동시에 들어온 run은 도착 순서대로 직렬 실행된다. 파일 영역 경합과 resume id 꼬임을 구조적으로 차단한다. 서로 다른 세션은 병렬이다.
4. **자원 회수** — idle TTL(기본 30분)이 지난 세션은 스위퍼가 워크스페이스째 회수한다. 세션 수 상한 도달 시 LRU idle 세션을 먼저 회수한다.

## 6. Tool 표면 최소화

하네스가 `tools.allow / tools.deny`를 선언하면 드라이버가 백엔드 네이티브 옵션으로 번역한다.

| 백엔드 | 매핑 | 세밀도 |
|---|---|---|
| claude | `--allowedTools`, `--disallowedTools`, `--max-turns` | tool 단위 + 패턴(`Bash(node:*)`) — 가장 세밀 |
| codex | `--sandbox read-only\|workspace-write\|danger-full-access` | sandbox 모드 단위 — 거침. 세밀 제어가 필요하면 claude/pi 백엔드 권장 |
| pi | 프로그래매틱 tool 등록 (커스텀 어댑터 확장 지점) | v0.1은 단발 CLI 실행, tool 제어는 후속 |

tool 표면이 좁을수록 (1) agent가 탐색에 낭비하는 턴이 줄어 지연·비용이 내려가고 (2) 프롬프트 인젝션 시 폭발 반경이 줄어든다. `limits.maxTurns` / `limits.timeoutMs`는 폭주 run의 상한이다.

## 7. 이벤트·산출물 계약

모든 백엔드 출력은 공통 `RunEvent`로 정규화된다: `run:start`, `agent:message`, `agent:thinking`, `tool:call`, `tool:result`, `run:done`, `run:error`. HTTP 파사드는 이를 그대로 SSE로 중계하므로 SaaS 클라이언트는 백엔드 종류를 몰라도 진행 상황을 렌더링할 수 있다.

산출물은 하네스의 `artifacts.globs`로 선언한다. run 종료 후 워크스페이스에서 매칭 파일을 수집해 `RunResult.artifacts`(상대경로, 절대경로, 크기)로 반환한다. 파일 서빙(다운로드 URL 발급 등)은 프레임워크 밖 SaaS 계층의 책임이다.

## 8. API

### 임베디드 SDK

```ts
const box = new Agentbox({ maxConcurrentRuns: 8 });
box.register(pptGenerate);

const result = await box.run(
  { session: { userId: 'u1', goalId: 'q2-deck' }, harness: 'ppt-generate', prompt: '2분기 실적 덱' },
  (event) => console.log(event),
);
// result.artifacts → [{ path: 'out/deck.pptx', ... }]
```

### HTTP 파사드
- `POST /v1/runs` — body `{ session: { userId, goalId }, harness, prompt }`, 응답은 SSE 이벤트 스트림
- `GET /v1/harnesses` — 등록된 하네스 목록
- `GET /v1/stats` — 세션 수 / 실행 중 / 대기 중 run 수

## 9. 확인이 필요한 가정

- **pi CLI 호출 형태**: 기본값을 `pi -p "<prompt>"`로 두었다. 배포 환경의 pi 버전과 다르면 `driverOptions.command / args`로 오버라이드한다. 확정되면 기본값을 갱신한다.
- **codex `--json` 이벤트 스키마**: experimental이라 필드가 바뀔 수 있다. 파서는 미인식 라인을 무시하도록 방어적으로 작성했다.
- **claude stream-json**: `system:init / assistant / user / result` 메시지 타입 기준이며 CLI 버전 업그레이드 시 재검증이 필요하다.

## 10. 로드맵

- **v0.2** — container `SandboxProvider`(볼륨=세션, 실행 컨테이너 풀), run 취소 API, artifact 스토어 연동(S3 등)
- **v0.3** — pi 프로그래매틱 tool 등록(커스텀 tool을 하네스 선언에 포함), MCP 서버 주입(`tools.mcpServers`) 전 백엔드 지원
- **v0.4** — 메트릭(run 지연/토큰/실패율), 세션 웜풀(예측 프리워밍), 멀티노드 스케줄링(세션→노드 어피니티)
