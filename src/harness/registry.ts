import type { HarnessSpec } from '../types.js';

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const BACKENDS = new Set(['pi', 'codex', 'claude']);

/** Helper for declaring a harness while keeping type inference */
export function defineHarness(spec: HarnessSpec): HarnessSpec {
  return spec;
}

export class HarnessRegistry {
  private readonly specs = new Map<string, HarnessSpec>();

  register(spec: HarnessSpec): void {
    this.validate(spec);
    if (this.specs.has(spec.name)) {
      throw new Error(`harness "${spec.name}" is already registered`);
    }
    this.specs.set(spec.name, spec);
  }

  /** Registers or replaces. Used by loaders that reload harness files at runtime. */
  upsert(spec: HarnessSpec): void {
    this.validate(spec);
    this.specs.set(spec.name, spec);
  }

  unregister(name: string): boolean {
    return this.specs.delete(name);
  }

  get(name: string): HarnessSpec {
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`unknown harness "${name}"`);
    return spec;
  }

  has(name: string): boolean {
    return this.specs.has(name);
  }

  list(): HarnessSpec[] {
    return [...this.specs.values()];
  }

  private validate(spec: HarnessSpec): void {
    if (!NAME_RE.test(spec.name)) {
      throw new Error(`invalid harness name "${spec.name}" (expected ${NAME_RE})`);
    }
    if (!BACKENDS.has(spec.backend)) {
      throw new Error(`unknown backend "${spec.backend}" for harness "${spec.name}"`);
    }
    if (spec.limits?.timeoutMs !== undefined && spec.limits.timeoutMs <= 0) {
      throw new Error(`harness "${spec.name}" has non-positive timeoutMs`);
    }
    if (spec.limits?.maxTurns !== undefined && spec.limits.maxTurns <= 0) {
      throw new Error(`harness "${spec.name}" has non-positive maxTurns`);
    }
    if (spec.limits?.maxWorkspaceBytes !== undefined && spec.limits.maxWorkspaceBytes <= 0) {
      throw new Error(`harness "${spec.name}" has non-positive maxWorkspaceBytes`);
    }
    if (spec.retry !== undefined && spec.retry.maxAttempts < 1) {
      throw new Error(`harness "${spec.name}" has retry.maxAttempts < 1`);
    }
  }
}
