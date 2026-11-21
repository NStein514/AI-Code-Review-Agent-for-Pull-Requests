import { describe, expect, it, vi } from "vitest";
import { ReviewQueue } from "../src/queue.js";
import type { ReviewJob } from "../src/review/reviewer.js";

const baseJob: ReviewJob = {
  installationId: 1,
  owner: "acme",
  repo: "api",
  pullNumber: 7,
  headSha: "a".repeat(40),
  action: "opened",
};

describe("ReviewQueue reruns", () => {
  it("coalesces webhooks during an active review into one rerun for the newest commit", async () => {
    const started: ReviewJob[] = [];
    const releases: Array<() => void> = [];

    const handler = vi.fn((job: ReviewJob) => {
      started.push(job);
      return new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    });

    const queue = new ReviewQueue({ concurrency: 1, handler });

    expect(queue.enqueue({ ...baseJob, headSha: "a".repeat(40) })).toBe(true);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    queue.enqueue({ ...baseJob, headSha: "b".repeat(40) });
    queue.enqueue({ ...baseJob, headSha: "c".repeat(40) });

    // One running review plus one coalesced rerun.
    expect(queue.size).toBe(2);
    expect(queue.activeCount).toBe(1);

    releases.shift()?.();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    expect(started.map((job) => job.headSha)).toEqual([
      "a".repeat(40),
      "c".repeat(40),
    ]);

    releases.shift()?.();
    await queue.drain();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(queue.size).toBe(0);
    expect(queue.activeCount).toBe(0);
  });

  it("runs independent pull requests concurrently up to the limit", async () => {
    const releases: Array<() => void> = [];
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );

    const queue = new ReviewQueue({ concurrency: 2, handler });
    queue.enqueue({ ...baseJob, pullNumber: 1 });
    queue.enqueue({ ...baseJob, pullNumber: 2 });
    queue.enqueue({ ...baseJob, pullNumber: 3 });

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    expect(queue.size).toBe(3);

    releases.shift()?.();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(3));

    releases.splice(0).forEach((release) => release());
    await queue.drain();
    expect(queue.size).toBe(0);
  });
});
