export class QueueFullError extends Error {
  constructor(limit: number) {
    super(`run queue is full (limit ${limit})`);
    this.name = 'QueueFullError';
  }
}

export class QueueTimeoutError extends Error {
  constructor(ms: number) {
    super(`run waited longer than ${ms}ms in queue`);
    this.name = 'QueueTimeoutError';
  }
}

interface Job {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer?: NodeJS.Timeout;
}

export interface FairSchedulerOptions {
  /** Pending-queue cap. Excess submissions fail fast with QueueFullError. */
  maxQueued?: number;
  /** Cap on concurrently running jobs per lane (per user). */
  maxPerLane?: number;
  /** Reject jobs still queued after this long with QueueTimeoutError. */
  queueTimeoutMs?: number;
}

/**
 * Fair scheduler: a global concurrency cap plus round-robin across lanes
 * (usually userId). One user flooding the queue cannot starve other users'
 * runs, a per-lane cap keeps one tenant from monopolizing every slot, and
 * bounded queueing fails fast under overload instead of building an
 * unbounded backlog.
 */
export class FairScheduler {
  private readonly lanes = new Map<string, Job[]>();
  private order: string[] = [];
  private running = 0;
  private readonly runningByLane = new Map<string, number>();

  constructor(
    private readonly maxConcurrent: number,
    private readonly opts: FairSchedulerOptions = {},
  ) {
    if (maxConcurrent < 1) throw new Error('maxConcurrent must be >= 1');
  }

  schedule<T>(lane: string, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const maxQueued = this.opts.maxQueued ?? Infinity;
      const canRunNow =
        this.running < this.maxConcurrent &&
        (this.runningByLane.get(lane) ?? 0) < (this.opts.maxPerLane ?? Infinity);
      // Backpressure applies only to jobs that would actually wait.
      if (!canRunNow && this.pendingCount >= maxQueued) {
        reject(new QueueFullError(maxQueued));
        return;
      }
      const job: Job = {
        task,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      if (this.opts.queueTimeoutMs !== undefined) {
        job.timer = setTimeout(() => {
          this.removeQueued(lane, job);
          job.reject(new QueueTimeoutError(this.opts.queueTimeoutMs!));
        }, this.opts.queueTimeoutMs);
        job.timer.unref?.();
      }
      let queue = this.lanes.get(lane);
      if (!queue) {
        queue = [];
        this.lanes.set(lane, queue);
        this.order.push(lane);
      }
      queue.push(job);
      this.pump();
    });
  }

  private removeQueued(lane: string, job: Job): void {
    const queue = this.lanes.get(lane);
    if (!queue) return;
    const index = queue.indexOf(job);
    if (index < 0) return; // already running
    queue.splice(index, 1);
    if (queue.length === 0) {
      this.lanes.delete(lane);
      this.order = this.order.filter((l) => l !== lane);
    }
  }

  private pump(): void {
    while (this.running < this.maxConcurrent) {
      const picked = this.nextJob();
      if (!picked) return;
      const { lane, job } = picked;
      if (job.timer) clearTimeout(job.timer);
      this.running++;
      this.runningByLane.set(lane, (this.runningByLane.get(lane) ?? 0) + 1);
      job.task().then(job.resolve, job.reject).finally(() => {
        this.running--;
        const left = (this.runningByLane.get(lane) ?? 1) - 1;
        if (left <= 0) this.runningByLane.delete(lane);
        else this.runningByLane.set(lane, left);
        this.pump();
      });
    }
  }

  private nextJob(): { lane: string; job: Job } | undefined {
    const maxPerLane = this.opts.maxPerLane ?? Infinity;
    const rounds = this.order.length;
    for (let scanned = 0; scanned < rounds; scanned++) {
      const lane = this.order.shift()!;
      if ((this.runningByLane.get(lane) ?? 0) >= maxPerLane) {
        this.order.push(lane); // lane at capacity rotates to the back
        continue;
      }
      const queue = this.lanes.get(lane)!;
      const job = queue.shift()!;
      if (queue.length > 0) this.order.push(lane);
      else this.lanes.delete(lane);
      return { lane, job };
    }
    return undefined;
  }

  get pendingCount(): number {
    let count = 0;
    for (const queue of this.lanes.values()) count += queue.length;
    return count;
  }

  get runningCount(): number {
    return this.running;
  }
}
