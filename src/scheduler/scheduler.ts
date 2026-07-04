interface Job {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * Fair scheduler: a global concurrency cap plus round-robin across lanes
 * (usually userId). One user flooding the queue cannot starve other users' runs.
 */
export class FairScheduler {
  private readonly lanes = new Map<string, Job[]>();
  private order: string[] = [];
  private running = 0;

  constructor(private readonly maxConcurrent: number) {
    if (maxConcurrent < 1) throw new Error('maxConcurrent must be >= 1');
  }

  schedule<T>(lane: string, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let queue = this.lanes.get(lane);
      if (!queue) {
        queue = [];
        this.lanes.set(lane, queue);
        this.order.push(lane);
      }
      queue.push({
        task,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pump();
    });
  }

  private pump(): void {
    while (this.running < this.maxConcurrent) {
      const job = this.nextJob();
      if (!job) return;
      this.running++;
      job.task().then(job.resolve, job.reject).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private nextJob(): Job | undefined {
    const lane = this.order.shift();
    if (lane === undefined) return undefined;
    const queue = this.lanes.get(lane)!;
    const job = queue.shift()!;
    if (queue.length > 0) {
      this.order.push(lane);
    } else {
      this.lanes.delete(lane);
    }
    return job;
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
