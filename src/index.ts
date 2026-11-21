import "dotenv/config";
import { ConfigError, loadConfig, type AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { ReviewQueue } from "./queue.js";
import { reviewPullRequest } from "./review/reviewer.js";
import { createServer } from "./server.js";

function readConfig(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.fatal(
      { err: error instanceof ConfigError ? undefined : error },
      `Failed to start: ${message}`,
    );
    process.exit(1);
  }
}

function main(): void {
  const config = readConfig();

  const queue = new ReviewQueue({
    concurrency: config.reviewMaxConcurrency,
    logger,
    handler: async (job) => {
      const jobLogger = logger.child({
        repository: `${job.owner}/${job.repo}`,
        pullRequest: job.pullNumber,
      });
      const outcome = await reviewPullRequest(config, job, jobLogger);
      jobLogger.info(outcome, "review job finished");
    },
  });

  const app = createServer({ config, queue, logger });
  const server = app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        model: config.anthropic.model,
        confidenceThreshold: config.review.confidenceThreshold,
        semgrep: config.semgrep.enabled,
      },
      "AI code review agent listening",
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, inFlight: queue.activeCount }, "shutting down");

    const forceExit = setTimeout(() => {
      logger.warn("shutdown timed out; exiting with work in flight");
      process.exit(1);
    }, 30_000);
    forceExit.unref();

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await queue.drain();
    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandled promise rejection");
  });
  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "uncaught exception");
    process.exit(1);
  });
}

main();
