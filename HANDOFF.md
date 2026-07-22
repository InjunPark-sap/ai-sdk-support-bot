# SAP AI SDK Support Bot — Handoff Notes for Kavitha

## What this is

A Manual RAG agent that answers questions about the SAP AI SDK.
- **Retrieval**: Context7 MCP (official docs) + GH MCP (past issues)
- **LLM**: `@sap-ai-sdk/langchain` `OrchestrationClient` → `claude-4.5-haiku` on SAP AI Core
- **Dogfooding**: uses our own SDK as the LLM layer

---

## How it works (retrieval — 5 parallel searches)

```
Question
  → ① context7__query-docs        (SAP AI SDK docs, 532 snippets)
  → ② github__search_issues        (exact question)
  → ③ github__search_issues        (camelCase keywords, stopword-filtered)
  → ④ github__search_issues        (PascalCase tech terms in:title)
  → ⑤ github__search_issues        (domain terms: masking/streaming/etc in:title)
  → dedup + OrchestrationClient synthesizes answer from context only
```

The model never answers from memory — retrieval always runs first.

---

## Public interface

```typescript
// src/agent.ts

// Call once at startup — starts MCP subprocesses
export async function initAgent(): Promise<void>

// Call on shutdown — cleans up MCP subprocesses
export async function closeAgent(): Promise<void>

// Main entry point — returns answer string
export async function askBot(question: string): Promise<string>
```

### Usage example

```typescript
import { initAgent, closeAgent, askBot } from './agent.js';

await initAgent();
const answer = await askBot('Which client should I use for chat completions?');
console.log(answer);
await closeAgent();
```

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `AICORE_SERVICE_KEY` | SAP AI Core service key (JSON string) |
| `GITHUB_TOKEN` | GitHub Personal Access Token (`repo` read scope) |

Copy `.env.example` to `.env` and fill in both values.

---

## Run locally

```bash
pnpm install
pnpm start
```

---

## GitHub Action (auto-reply on new issues)

### How it works
```
New issue opened on SAP/ai-sdk-js
  → .github/workflows/issue-reply.yml triggers
  → installs deps, runs src/reply.ts with issue title+body
  → posts answer as a comment on the issue
```

### Setup (one-time)

1. Add secrets to the target repo (**Settings → Secrets and variables → Actions**):

| Secret | Value |
|--------|-------|
| `AICORE_SERVICE_KEY` | SAP AI Core service key (full JSON string) |
| `GITHUB_TOKEN` | Auto-provided by GitHub Actions — no setup needed |

2. Copy `.github/workflows/issue-reply.yml` into the target repo.

3. Done — next issue opened triggers the bot automatically.

### Files added
```
.github/workflows/issue-reply.yml  ← workflow definition
src/reply.ts                       ← CLI entry point for Action
```

### Security note
Issue title and body are passed via environment variables (not interpolated directly into shell commands) to prevent command injection.

---

## Connecting to GitHub App (Kavitha's part — stretch)

If you want a named bot identity (not `github-actions[bot]`), wrap `askBot()` in the Express server:

```
New issue opened
  → GitHub App webhook → POST /ask { question: issue.title + "\n\n" + issue.body }
  → askBot(question)
  → POST /repos/SAP/ai-sdk-js/issues/{n}/comments { body: answer }
```

Run the server with `pnpm serve` (port 3000).

---

## Key implementation decisions

| Decision | Reason |
|----------|--------|
| Manual RAG (not agentic) | Model was skipping tool calls and hallucinating — code now always retrieves first |
| Library ID hardcoded `/websites/sap_github_io_ai-sdk_js` | Benchmark score 83, 532 snippets — most reliable JS SDK source |
| `docs.slice(0, 4000)` + 5-query parallel search + dedup | SAP AI Core token limit + broader issue coverage |
| `anthropic--claude-4.5-haiku` | Only Claude model deployed in our AI Core instance |

---

## File structure

```
src/
  agent.ts   ← RAG pipeline (edit here for retrieval changes)
  cli.ts     ← local test REPL
  server.ts  ← Express HTTP server (pnpm serve)
  reply.ts   ← CLI entry point for GitHub Action
.github/
  workflows/
    issue-reply.yml  ← GitHub Action definition
```
