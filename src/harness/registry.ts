import type { HarnessSpec } from '../types.js';

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const BACKENDS = new Set(['pi', 'codex', 'claude']);

/** 타입 추론을 유지하면서 하네스를 선언하기 위한 헬퍼 */
export function defineHarness(spec: HarnessSpec): HarnessSpec {
  return spec;
}

export class HarnessRegistry {
  private readonly specs = new Map<string, HarnessSpec>();

  register(spec: HarnessSpec): void {
    if (!NAME_RE.test(spec.name)) {
      throw new Error(`invalid harness name "${spec.name}" (expected ${NAME_RE})`);
    }
    if (!BACKENDS.has(spec.backend)) {
      throw new Error(`unknown backend "${spec.backend}" for harness "${spec.name}"`);
    }
    if (this.specs.has(spec.name)) {
      throw new Error(`harness "${spec.name}" is already registered`);
    }
    if (spec.limits?.timeoutMs !== undefined && spec.limits.timeoutMs <= 0) {
      throw new Error(`harness "${spec.name}" has non-positive timeoutMs`);
    }
    if (spec.limits?.maxTurns !== undefined && spec.limits.maxTurns <= 0) {
      throw new Error(`harness "${spec.name}" has non-positive maxTurns`);
    }
    this.specs.set(spec.name, spec);
  }

  get(name: string): HarnessSpec {
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`unknown harness "${name}"`);
    return spec;
  }

  list(): HarnessSpec[] {
    return [...this.specs.values()];
  }
}
