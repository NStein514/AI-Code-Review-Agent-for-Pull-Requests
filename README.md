# AI Code Review Agent for Pull Requests

A GitHub App that reviews pull requests, flags bugs, security issues, and meaningful style problems, and posts **inline comments with suggested fixes**. Every finding carries a confidence score, and findings below the threshold are listed in the summary instead of being posted inline, so reviewers know what to trust.

A deterministic [Semgrep](https://semgrep.dev) pass runs first as a baseline. Its findings are given to the model as context and merged into the output, so known-vulnerable patterns are reported even when the model misses them.

## Example

A pull request introduces a query built with string concatenation:

```ts
const users = await db.query(
  "SELECT id, email FROM users WHERE name = '" + name + "'",
);
```

The agent posts an inline comment on that line:

> **Possible SQL injection in user search** · `high` · security
>
> `name` comes straight from the query string and is concatenated into the SQL text. Any caller can read or modify arbitrary rows with a crafted `name` value.
>
> ```suggestion
> const users = await db.query(
>   "SELECT id, email FROM users WHERE name = $1",
>   [name],
> );
> ```
>
> _Confidence 94% · corroborated by Semgrep_

and one summary review:

> **3 issues found** · 1 high · 2 low · 4 files reviewed

## How it works

1. GitHub sends a `pull_request` webhook (`opened`, `reopened`, `synchronize`, `ready_for_review`).
2. The server verifies the HMAC-SHA256 signature, acknowledges in milliseconds, and queues the review.
3. The reviewer fetches the PR and changed files, then parses each unified diff into hunks with exact head-side line numbers.
4. Changed source files are fetched and scanned with Semgrep. Missing CLI or broken rules degrade gracefully.
5. Claude reviews batches of annotated diffs with **forced tool use**, returning findings through a JSON schema instead of prose.
6. Every finding is validated against the diff: the path must exist, the line must be visible on the head side (nearby lines snap within three rows), and quoted evidence must match.
7. Confidence is adjusted: corroborated findings are raised, unverifiable evidence lowers confidence and drops the suggestion.
8. Findings below `REVIEW_CONFIDENCE_THRESHOLD` are withheld from inline comments and listed in the summary. The rest are posted as a single review with inline comments and GitHub suggestion blocks.

A hidden marker (`<!-- ai-code-review:<sha> -->`) in the review body makes re-deliveries for the same commit idempotent.

```
GitHub webhook ──▶ Express (signature check) ──▶ ReviewQueue
                                                    │
                              ┌─────────────────────┴─────────────────────┐
                              ▼                                           ▼
                    Diff parser (head lines)                    Semgrep baseline
                              │                                           │
                              └───────────────┬───────────────────────────┘
                                              ▼
                               Claude tool use (batched, schema-validated)
                                              ▼
                          Diff validation · dedupe · confidence scoring
                                              ▼
                              Review with inline comments + summary
```

## Project layout

```
src/
  index.ts              entrypoint, graceful shutdown
  server.ts             Express app, webhook verification, event routing
  queue.ts              bounded in-process queue with per-PR dedupe
  config.ts             zod-validated environment configuration
  logger.ts             pino logger
  github/
    app.ts              cached GitHub App installation clients
    diff.ts             unified-diff parsing and line mapping
    contents.ts         head-revision file contents for Semgrep
  review/
    reviewer.ts         orchestration and posting
    analyzer.ts         Claude tool-use client with batching
    prompt.ts           system/user prompts and diff budgeting
    tools.ts            submit_findings tool schema
    findings.ts         validation, dedupe, confidence, merging
    semgrep.ts          CLI runner and JSON parsing
    summary.ts          review/comment formatting and markers
  cli/
    review-diff.ts      local dry run against a saved diff
semgrep/rules.yml       local baseline rules (no network required)
fixtures/               sample diff and demo source tree
tests/                  unit tests for the pure logic
```

## Quickstart

### 1. Create the GitHub App

In **Settings → Developer settings → GitHub Apps → New GitHub App**:

- **Webhook URL**: your public URL plus `/webhook` (use ngrok or smee for local work).
- **Webhook secret**: a random string of at least 16 characters.
- **Repository permissions**:
  - Pull requests: **Read and write** (needed to post reviews)
  - Contents: **Read** (needed to fetch changed files)
  - Metadata: **Read** (mandatory)
- **Subscribe to events**: **Pull request**.
- Create the app, generate a **private key**, and note the **App ID**.
- **Install** the app on the repositories you want reviewed.

### 2. Configure

```bash
cp .env.example .env
```

Fill in `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`, the private key (inline with `\n` escapes, or `GITHUB_PRIVATE_KEY_PATH`), and `ANTHROPIC_API_KEY`.

`ANTHROPIC_MODEL` defaults to `claude-sonnet-5-5`; set it to any model available to your account that supports tool use.

### 3. Run

```bash
npm install
npm run dev
```

`GET /healthz` should return `{"status":"ok",...}`. Expose port 3000 publicly:

```bash
ngrok http 3000
# or, with a smee channel:
npx smee-client --url https://smee.io/<channel> --target http://localhost:3000/webhook
```

Open a pull request (or push to an existing one) and the review appears within a minute or two.

### 4. Semgrep (optional but recommended)

```bash
python -m pip install semgrep
semgrep --validate --config semgrep/rules.yml
```

The app calls the `semgrep` binary if it is on `PATH`. Without it, reviews still run and the summary reports `Semgrep baseline: unavailable`.

## Local dry run

Review a saved diff without GitHub, a webhook, or an installation:

```bash
npm run review:diff -- --diff fixtures/sql-injection.diff
```

With Semgrep over the matching demo tree:

```bash
npm run review:diff -- --diff fixtures/sql-injection.diff --dir fixtures/demo-repo
```

Useful flags: `--threshold 0.75`, `--no-semgrep`, `--json`. The dry run needs `ANTHROPIC_API_KEY` and never posts anything.

## Confidence scoring

The model scores each finding from 0 to 1. The reviewer then adjusts:

| Situation | Effect |
| --- | --- |
| Semgrep independently reports the same location and category | confidence raised to at least 0.95, marked "corroborated" |
| Semgrep-only finding | starts at 0.92 and is marked deterministic |
| Quoted evidence does not match the diff | confidence × 0.85, suggestion dropped |
| No evidence, or a suggestion containing code fences | suggestion dropped |
| Below `REVIEW_CONFIDENCE_THRESHOLD` (default 0.6) | withheld from inline comments, listed in the summary |
| Over `REVIEW_MAX_FINDINGS` | lowest severity/confidence findings listed in the summary |

Suggestions are only posted when the quoted evidence was verified, and they are placed in a GitHub `suggestion` block, so the author can apply the fix with one click.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `development` | `production` disables pretty logs |
| `LOG_LEVEL` | `info` | pino log level |
| `LOG_PRETTY` | `true` outside production | Human-readable logs |
| `GITHUB_APP_ID` | — | Numeric GitHub App ID |
| `GITHUB_PRIVATE_KEY` | — | PEM contents; `\n` escapes are expanded |
| `GITHUB_PRIVATE_KEY_PATH` | — | Alternative to the inline key |
| `GITHUB_WEBHOOK_SECRET` | — | HMAC secret for webhooks (16+ chars) |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Model id |
| `ANTHROPIC_MAX_TOKENS` | `8192` | Max output tokens per batch |
| `REVIEW_CONFIDENCE_THRESHOLD` | `0.6` | Inline comment cutoff |
| `REVIEW_MAX_FILES` | `20` | Files analyzed per review |
| `REVIEW_MAX_DIFF_CHARS` | `60000` | Diff budget per model call |
| `REVIEW_MAX_FILE_PATCH_CHARS` | `24000` | Larger patches are skipped |
| `REVIEW_MAX_FINDINGS` | `25` | Hard cap on inline comments |
| `REVIEW_MAX_CONCURRENCY` | `2` | Concurrent PR reviews |
| `REVIEW_SKIP_DRAFTS` | `true` | Ignore draft PRs |
| `REVIEW_REVIEW_FORKS` | `false` | Fork PRs run analysis on untrusted code |
| `REVIEW_SUMMARY_ON_CLEAN` | `true` | Post "no issues found" summaries |
| `REVIEW_TRIGGER_ACTIONS` | `opened,reopened,synchronize,ready_for_review` | Handled PR actions |
| `REVIEW_CUSTOM_INSTRUCTIONS` | — | Extra maintainer rules appended to the prompt |
| `SEMGREP_ENABLED` | `true` | Run the static-analysis baseline |
| `SEMGREP_CONFIG` | `./semgrep/rules.yml` | Local path, or `auto` / `p/security-audit` |
| `SEMGREP_TIMEOUT_MS` | `120000` | CLI timeout |
| `SEMGREP_MAX_FILE_BYTES` | `200000` | Files larger than this are skipped |

## Docker

```bash
docker build -t ai-code-review-agent .
docker run --rm -p 3000:3000 --env-file .env ai-code-review-agent
```

The runtime image runs as a non-root user and contains no build tooling. To include Semgrep in the image:

```bash
docker build --target with-semgrep -t ai-code-review-agent:semgrep .
```

`docker compose up --build` uses the same image with a read-only filesystem and a `/tmp` tmpfs for Semgrep's scratch directory.

## CI

`.github/workflows/ci.yml` runs `npm ci`, the typechecker, the test suite, the build, and a Docker image build on every push and pull request.

## Deployment notes

- The app is stateless apart from an in-memory queue; run a **single instance** or put a shared queue in front of it before scaling horizontally.
- Pin the image tag, keep the webhook secret and private key in a secret manager, and never bake `.env` into an image.
- Rotate the GitHub App private key and Anthropic key on a schedule.
- Behind a proxy, preserve raw request bodies for webhook signature verification; this app reads the raw buffer itself.
- Fork pull requests are skipped by default because the model and Semgrep would run on untrusted code.
- GitHub rate limits are retried only by the Anthropic SDK; add Octokit throttling/retry plugins if you review a large org.

## Limitations and next steps

- Findings are limited to lines visible in the current diff, so the model cannot comment on untouched files.
- Very large PRs are capped by file count, patch size, and diff characters; skipped files are listed in the summary.
- There is no incremental review on force-push: each new head commit is reviewed in full.
- Natural next steps: a Redis-backed queue for horizontal scaling, Octokit retry/throttling plugins, per-repository configuration files, and storing review history for evaluation against Semgrep.

## Testing

```bash
npm test          # 49 unit tests: diff mapping, validation, scoring, prompts, webhooks
npm run typecheck
npm run build
```

The tests cover the pure logic: unified-diff parsing and line snapping, tool-payload validation, evidence-gated suggestions, Semgrep merging, summary formatting, prompt budgeting, and webhook signature/job extraction.
