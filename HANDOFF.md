# SAP AI SDK Support Bot — Handoff Notes for Kavitha

## What this is

A Manual RAG agent that answers questions about the SAP AI SDK.
- **Retrieval**: Context7 MCP (official docs) + GH MCP (past issues)
- **LLM**: `@sap-ai-sdk/langchain` `OrchestrationClient` → `claude-4.5-haiku` on SAP AI Core
- **Dogfooding**: uses our own SDK as the LLM layer

---

## How it works (3 steps, always in this order)

```
Question
  → ① context7__query-docs (SAP AI SDK docs, 532 snippets)
  → ② github__search_issues (repo:SAP/ai-sdk-js, top 3)
  → ③ OrchestrationClient synthesizes answer from retrieved context only
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

## Connecting to GitHub bot (your part)

Add an Express endpoint that wraps `askBot()`:

```typescript
import express from 'express';
import { initAgent, askBot } from './agent.js';

const app = express();
app.use(express.json());

await initAgent();

app.post('/ask', async (req, res) => {
  const { question } = req.body as { question: string };
  const answer = await askBot(question);
  res.json({ answer });
});

app.listen(3000);
```

GitHub webhook flow:
```
New issue opened
  → GitHub App webhook → POST /ask { question: issue.body }
  → askBot(issue.body)
  → POST /repos/SAP/ai-sdk-js/issues/{n}/comments { body: answer }
```

---

## Key implementation decisions

| Decision | Reason |
|----------|--------|
| Manual RAG (not agentic) | Model was skipping tool calls and hallucinating — code now always retrieves first |
| Library ID hardcoded `/websites/sap_github_io_ai-sdk_js` | Benchmark score 83, 532 snippets — most reliable JS SDK source |
| `docs.slice(0, 4000)` + `per_page: 3` + `summarizeIssues()` | SAP AI Core token limit — strips issue metadata, keeps only number/title/body(300 chars) |
| `anthropic--claude-4.5-haiku` | Only Claude model deployed in our AI Core instance |

---

## File structure

```
src/
  agent.ts   ← RAG pipeline (edit here for retrieval changes)
  cli.ts     ← local test REPL (not needed for GitHub bot)
```
