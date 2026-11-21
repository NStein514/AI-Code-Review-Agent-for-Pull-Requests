import pino, { type Logger } from "pino";

const isProduction = process.env.NODE_ENV === "production";
const isTest = process.env.NODE_ENV === "test";
const prettyFlag = process.env.LOG_PRETTY;
const pretty =
  !isTest &&
  (prettyFlag === undefined ? !isProduction : /^(1|true|yes|on)$/i.test(prettyFlag));

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? (isTest ? "silent" : "info"),
  base: { service: "ai-code-review" },
  ...(pretty
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname",
          },
        },
      }
    : {}),
});

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
