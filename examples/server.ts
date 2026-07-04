import { Agentbox, createHttpServer } from '../src/index.js';
import { bashGenerate, docGenerate, pptGenerate } from './harnesses.js';

/**
 * Boot the demo server:
 *   npx tsx examples/server.ts
 *
 * Example request:
 *   curl -N localhost:8787/v1/runs -d '{
 *     "session": { "userId": "u1", "goalId": "quarterly-deck" },
 *     "harness": "ppt-generate",
 *     "prompt": "A five-slide deck summarizing Q2 results"
 *   }'
 */
const box = new Agentbox({ maxConcurrentRuns: 4 });
box.register(pptGenerate).register(bashGenerate).register(docGenerate);

const port = Number(process.env.PORT ?? 8787);
createHttpServer(box).listen(port, () => {
  console.log(`agentbox listening on :${port}`);
  console.log('harnesses:', box.harnesses().map((h) => h.name).join(', '));
});
