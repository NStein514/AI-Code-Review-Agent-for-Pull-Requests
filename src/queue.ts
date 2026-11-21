import type { Logger } from "pino";
import type { ReviewJob } from "./review/reviewer.js";

export interface ReviewQueueOptions {
  concurrency: number;
  handler: (job: ReviewJob) => Promise<void>;
  logger?: Logger;
}

export function jobKey(job: ReviewJob): string {
  return `${job.installationId}:${job.owner}/${job.repo}#${job.pullNumber}`;
}

/**
 * A small bounded queue. Webhooks must be acknowledged quickly, so reviews run
 * in the background. A second webhook for the same PR while one review is
 * running becomes a single rerun for the newest commit instead of piling up.
 */
export class ReviewQueue {
  private readonly pending = new Map<string, ReviewJob>();
  private readonly active = new Set<string>();
  private readonly rerun = new Map<string, ReviewJob>();
  private idleWaiters: Array<() => void> = [];
  private running = 0;

  constructor(private readonly options: ReviewQueueOptions) {}

  enqueue(job: ReviewJob): boolean {
    const key = jobKey(job);

    if (this.active.has(key)) {
      this.rerun.set(key, job);
      return false;
    }
    if (this.pending.has(key)) {
      this.pending.set(key, job);
      return false;
    }

    this.pending.set(key, job);
    this.pump();
    return true;
  }

  get size(): number {
    // A rerun is queued work even though it only starts after the active job.
    return this.running + this.pending.size + this.rerun.size;
  }

  get activeCount(): number {
    return this.running;
  }

  async drain(): Promise<void> {
    if (this.running === 0 && this.pending.size === 0) return;
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private pump(): void {
    while (this.running < this.options.concurrency && this.pending.size > 0) {
      const next = this.pending.entries().next();
      if (next.done) break;

      const [key, job] = next.value;
      this.pending.delete(key);
      this.active.add(key);
      this.running += 1;
      void this.run(key, job);
    }
  }

  private async run(key: string, job: ReviewJob): Promise<void> {
    try {
      await this.options.handler(job);
    } catch (error) {
      this.options.logger?.error({ err: error, job }, "queued review job failed");
    } finally {
      this.active.delete(key);
      this.running -= 1;

      const latest = this.rerun.get(key);
      if (latest) {
        this.rerun.delete(key);
        this.pending.set(key, latest);
      }

      this.pump();

      if (this.running === 0 && this.pending.size === 0) {
        const waiters = this.idleWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    }
  }
}
