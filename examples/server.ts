import { Agentbox, createHttpServer } from '../src/index.js';
import { bashGenerate, docGenerate, pptGenerate } from './harnesses.js';

/**
 * 데모 서버 부팅:
 *   npx tsx examples/server.ts
 *
 * 실행 예:
 *   curl -N localhost:8787/v1/runs -d '{
 *     "session": { "userId": "u1", "goalId": "quarterly-deck" },
 *     "harness": "ppt-generate",
 *     "prompt": "2분기 실적 요약 5장짜리 덱"
 *   }'
 */
const box = new Agentbox({ maxConcurrentRuns: 4 });
box.register(pptGenerate).register(bashGenerate).register(docGenerate);

const port = Number(process.env.PORT ?? 8787);
createHttpServer(box).listen(port, () => {
  console.log(`agentbox listening on :${port}`);
  console.log('harnesses:', box.harnesses().map((h) => h.name).join(', '));
});
