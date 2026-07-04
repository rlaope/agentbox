import { spawn } from 'node:child_process';
import type { Sandbox, VerificationResult, VerifySpec } from '../types.js';

const DEFAULT_VERIFY_TIMEOUT_MS = 2 * 60_000;

/**
 * Runs a harness's verify command inside the sandbox and reports whether it
 * passed. Because the check executes in the same workspace the agent wrote to,
 * it can actually exercise the output (run the script, lint, open the file) —
 * not just judge text. The command crosses the sandbox boundary via
 * wrapCommand, exactly like a driver invocation.
 */
export async function runVerification(sandbox: Sandbox, spec: VerifySpec, signal: AbortSignal): Promise<VerificationResult> {
  // An empty command can't verify anything; fail closed rather than crash.
  if (spec.command.length === 0) {
    return { passed: false, exitCode: null, output: 'verify command is empty' };
  }
  const wrapped = sandbox.wrapCommand({ command: spec.command[0], args: spec.command.slice(1) });
  const timeoutMs = spec.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;

  return await new Promise<VerificationResult>((resolve) => {
    const child = spawn(wrapped.command, wrapped.args, { cwd: sandbox.root, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const capture = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ passed: exitCode === 0, exitCode, output: output.trim() });
    };
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      output = `${output}\nspawn error: ${err.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
