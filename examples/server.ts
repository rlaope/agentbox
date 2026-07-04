import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agentbox, createHttpServer } from '../src/index.js';
import { bashGenerate } from './harnesses.js';

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

// Code-level harness (escape hatch).
box.register(bashGenerate);

// Markdown harnesses, hot-reloaded on edit while the server runs.
const harnessDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'harnesses');
await box.loadHarnessDir(harnessDir, { watch: true });

const port = Number(process.env.PORT ?? 8787);
createHttpServer(box).listen(port, () => {
  console.log(`agentbox listening on :${port}`);
  console.log('harnesses:', box.harnesses().map((h) => h.name).join(', '));
});
