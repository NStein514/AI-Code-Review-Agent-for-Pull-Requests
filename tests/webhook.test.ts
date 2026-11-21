import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { configForTests } from "./helpers.js";
import { extractReviewJob, verifyWebhookSignature } from "../src/server.js";

const config = configForTests();

function sign(body: string, secret = "0123456789abcdef"): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifyWebhookSignature", () => {
  it("accepts a valid signature", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(
      verifyWebhookSignature(Buffer.from(body), "0123456789abcdef", sign(body)),
    ).toBe(true);
  });

  it("rejects a tampered body or missing signature", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(
      verifyWebhookSignature(Buffer.from(`${body} `), "0123456789abcdef", sign(body)),
    ).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(body), "0123456789abcdef", undefined)).toBe(
      false,
    );
  });
});

describe("extractReviewJob", () => {
  const payload = {
    action: "opened",
    installation: { id: 99 },
    repository: { name: "api", owner: { login: "acme" } },
    pull_request: { number: 12, head: { sha: "c".repeat(40) } },
    sender: { login: "dev", type: "User" },
  };

  it("builds a job for a handled pull_request action", () => {
    const result = extractReviewJob("pull_request", payload, config);
    expect(result.job).toEqual({
      installationId: 99,
      owner: "acme",
      repo: "api",
      pullNumber: 12,
      headSha: "c".repeat(40),
      action: "opened",
    });
  });

  it("ignores closed PRs and bot senders", () => {
    expect(
      extractReviewJob("pull_request", { ...payload, action: "closed" }, config).reason,
    ).toContain("ignored pull_request action");
    expect(
      extractReviewJob(
        "pull_request",
        { ...payload, sender: { login: "dependabot[bot]", type: "Bot" } },
        config,
      ).reason,
    ).toBe("sender is a bot");
  });

  it("handles ping and unsupported events", () => {
    expect(extractReviewJob("ping", {}, config).reason).toBe("ping");
    expect(extractReviewJob("push", payload, config).reason).toContain(
      "unsupported event",
    );
  });

  it("rejects incomplete payloads", () => {
    const result = extractReviewJob(
      "pull_request",
      { action: "opened", repository: { name: "api" } },
      config,
    );
    expect(result.job).toBeUndefined();
    expect(result.reason).toContain("missing installation");
  });
});
