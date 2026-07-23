# SAP AI SDK Support Bot

Automatically answers GitHub issues on `SAP/ai-sdk-js` using the SAP AI SDK itself — dogfooding `@sap-ai-sdk/langchain` to support `@sap-ai-sdk`.

**Trigger:** `issues: opened` → GitHub Actions (contributors only)  
**LLM:** `anthropic--claude-4.5-haiku` via `OrchestrationClient` on SAP AI Core  
**Retrieval:** Context7 MCP (docs) + GitHub MCP (issues) + local semantic search (embeddings)

---

## How it works

```
GitHub issue opened (MEMBER / OWNER / COLLABORATOR only)
  │
  ├── ① Post issue preview to Slack          (continue-on-error)
  ├── ② Generate answer — reply.ts → askBot()
  │       └── Agent loop (max 8 iterations)
  │             LLM decides which tools to call:
  │             • context7__query-docs    — official SAP AI SDK docs (532 snippets)
  │             • github__search_issues   — past issues keyword search
  │             • github__get_issue       — full issue body
  │             • github__search_code     — code examples in the repo
  │             • semantic_search         — local embedding index (cross-validation)
  ├── ③ Reply bot answer in Slack thread     (continue-on-error)
  └── ④ Post comment on GitHub issue         (always runs)
```

---

## Local setup

### Prerequisites

- Node.js 22+, pnpm 10+
- SAP AI Core service key with `anthropic--claude-4.5-haiku` deployment
- GitHub Personal Access Token (`repo` read scope)

### Install

```bash
pnpm install
cp .env.example .env
# Fill in AICORE_SERVICE_KEY and GITHUB_TOKEN in .env
```

### Run

```bash
pnpm start    # interactive CLI (readline REPL)
pnpm serve    # HTTP server on :3000 (POST /ask, GET /health)
pnpm build    # TypeScript type check
pnpm refresh  # Rebuild local embedding index from GitHub issues
```

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AICORE_SERVICE_KEY` | ✅ | SAP AI Core service key (full JSON string) |
| `GITHUB_TOKEN` | ✅ | GitHub PAT — `repo` read scope |
| `BOT_API_KEY` | optional | Bearer token for `POST /ask` (skip for local dev) |
| `PORT` | optional | HTTP server port (default: 3000) |
| `SLACK_BOT_TOKEN` | optional | Slack Bot OAuth token for issue notifications |
| `SLACK_CHANNEL_ID` | optional | Slack channel ID (e.g. `C...`) |

---

## GitHub Actions setup

### Secrets required (SAP/ai-sdk-js → Settings → Secrets → Actions)

| Secret | Value |
|--------|-------|
| `AICORE_SERVICE_KEY` | SAP AI Core service key JSON |
| `GITHUB_TOKEN` | Auto-provided by GitHub Actions |
| `SLACK_BOT_TOKEN` | `xoxb-...` Bot token (optional) |
| `SLACK_CHANNEL_ID` | Slack channel ID (optional) |

### Workflows

| File | Trigger | Purpose |
|------|---------|---------|
| `.github/workflows/issue-reply.yml` | `issues: opened` | Generate and post answer |
| `.github/workflows/refresh-embeddings.yml` | Weekly (Mon 03:00 UTC) + manual | Rebuild embedding index |

### Slack setup (optional)

1. [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch
2. OAuth & Permissions → Bot Token Scopes: `chat:write`, `chat:write.public`
3. Install to Workspace → copy Bot User OAuth Token (`xoxb-...`)
4. Add `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` secrets to the repo

---

## Embedding index

The local semantic search uses pre-built embeddings (`text-embedding-3-large`, 3072 dimensions).

| File | Contents | Count |
|------|----------|-------|
| `src/embeddings-resolved.json` | Closed issues with resolution | 71 |
| `src/embeddings-open.json` | Open issues | 13 |

Rebuild with `pnpm refresh` or trigger `refresh-embeddings.yml` manually.

---

## HTTP API

```
POST /ask
  Body: { "question": string }   (max 2000 chars)
  Auth: Authorization: Bearer <BOT_API_KEY>  (required if BOT_API_KEY is set)
  Response: { "answer": string }

GET /health
  Response: { "status": "ok" }
```

---

## Project structure

```
src/
  agent.ts              — askBot(), initAgent(), closeAgent() — core agent loop
  reply.ts              — GitHub Actions entry point (parses issue body → askBot)
  server.ts             — HTTP server entry point
  cli.ts                — Local REPL entry point
  embeddings.ts         — loadEmbeddingIndex(), semanticSearch()
  knowledge.ts          — SDK_KNOWLEDGE static reference (injected into system prompt)
  embeddings-resolved.json
  embeddings-open.json
scripts/
  refresh-embeddings.ts — Rebuild embedding index from GitHub API
.github/workflows/
  issue-reply.yml
  refresh-embeddings.yml
```

---

## Backlog

See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for planned improvements.
