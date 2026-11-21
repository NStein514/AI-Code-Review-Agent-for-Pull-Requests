import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import type { ReviewQueue } from "./queue.js";
import type { ReviewJob } from "./review/reviewer.js";

export interface WebhookPayload {
  action?: string;
  installation?: { id?: number };
  repository?: {
    name?: string;
    owner?: { login?: string };
  };
  pull_request?: {
    number?: number;
    head?: { sha?: string };
  };
  sender?: { login?: string; type?: string };
}

export type JobExtraction =
  | { job: ReviewJob; reason?: undefined }
  | { job?: undefined; reason: string };

/** Constant-time HMAC verification of `X-Hub-Signature-256`. */
export function verifyWebhookSignature(
  rawBody: Buffer,
  secret: string,
  signature: string | undefined,
): boolean {
  if (!signature) return false;

  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`;
  const provided = Buffer.from(signature, "utf8");
  const computed = Buffer.from(expected, "utf8");

  return (
    provided.length === computed.length && crypto.timingSafeEqual(provided, computed)
  );
}

export function extractReviewJob(
  eventName: string | undefined,
  payload: WebhookPayload,
  config: AppConfig,
): JobExtraction {
  if (eventName === "ping") return { reason: "ping" };
  if (eventName !== "pull_request") {
    return { reason: `unsupported event: ${eventName ?? "unknown"}` };
  }

  const action = payload.action ?? "";
  if (!config.review.triggerActions.includes(action)) {
    return { reason: `ignored pull_request action: ${action || "unknown"}` };
  }
  if (payload.sender?.type === "Bot") {
    return { reason: "sender is a bot" };
  }

  const installationId = payload.installation?.id;
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const pullNumber = payload.pull_request?.number;

  if (
    typeof installationId !== "number" ||
    !owner ||
    !repo ||
    typeof pullNumber !== "number"
  ) {
    return { reason: "payload is missing installation or repository data" };
  }

  return {
    job: {
      installationId,
      owner,
      repo,
      pullNumber,
      headSha: payload.pull_request?.head?.sha ?? "",
      action,
    },
  };
}

export function createServer(options: {
  config: AppConfig;
  queue: ReviewQueue;
  logger: Logger;
}): express.Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_request, response) => {
    response.json({
      status: "ok",
      uptimeSeconds: Math.round(process.uptime()),
      queueDepth: options.queue.size,
    });
  });

  app.post(
    "/webhook",
    express.raw({ type: "application/json", limit: "25mb" }),
    (request: Request, response: Response) => {
      const delivery = request.get("x-github-delivery") ?? "unknown";
      const eventName = request.get("x-github-event") ?? "";
      const rawBody = Buffer.isBuffer(request.body) ? request.body : undefined;

      if (!rawBody) {
        response.status(400).json({ error: "expected_application_json" });
        return;
      }

      if (
        !verifyWebhookSignature(
          rawBody,
          options.config.github.webhookSecret,
          request.get("x-hub-signature-256"),
        )
      ) {
        options.logger.warn({ delivery }, "rejected webhook with an invalid signature");
        response.status(401).json({ error: "invalid_signature" });
        return;
      }

      let payload: WebhookPayload;
      try {
        payload = JSON.parse(rawBody.toString("utf8")) as WebhookPayload;
      } catch {
        response.status(400).json({ error: "invalid_json" });
        return;
      }

      const extracted = extractReviewJob(eventName, payload, options.config);
      if (!extracted.job) {
        options.logger.debug(
          { delivery, event: eventName, reason: extracted.reason },
          "webhook ignored",
        );
        response.status(202).json({ ok: true, ignored: extracted.reason });
        return;
      }

      const queued = options.queue.enqueue(extracted.job);
      options.logger.info(
        {
          delivery,
          event: eventName,
          action: extracted.job.action,
          repository: `${extracted.job.owner}/${extracted.job.repo}`,
          pullRequest: extracted.job.pullNumber,
          queued,
        },
        queued ? "review queued" : "review already in progress; queued a rerun",
      );

      response.status(202).json({ ok: true, queued });
    },
  );

  app.use((_request, response) => {
    response.status(404).json({ error: "not_found" });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    options.logger.error({ err: error }, "request handling failed");
    if (response.headersSent) return;
    response.status(500).json({ error: "internal_error" });
  });

  return app;
}
