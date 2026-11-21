import { loadConfig, type AppConfig } from "../src/config.js";

/** Builds a validated config without touching the real environment. */
export function configForTests(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    ANTHROPIC_API_KEY: "test-key",
    GITHUB_APP_ID: "12345",
    GITHUB_WEBHOOK_SECRET: "0123456789abcdef",
    GITHUB_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
    LOG_LEVEL: "silent",
    ...overrides,
  });
}
