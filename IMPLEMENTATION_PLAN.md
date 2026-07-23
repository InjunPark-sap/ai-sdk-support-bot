# Implementation Plan — SAP AI SDK Support Bot

## Completed

| ID | Item | File | Evidence |
|----|------|------|----------|
| C-1 | `AICORE_SERVICE_KEY` MCP env isolation | `agent.ts:77,82` | `env: {}` for context7, only `GITHUB_TOKEN` for github MCP |
| C-2 | Prompt injection guard | `reply.ts:71` | `UNTRUSTED USER CONTENT BELOW` block prefix |
| C-3 | Loop exhaustion raw JSON prevention | `agent.ts:192` | `instanceof AIMessage` guard + final invoke |
| H-1 | `closeAgent()` always called | `reply.ts:78-84` | `try/finally` block |
| H-2 | MCP version pinned | `agent.ts:76,82` | `@upstash/context7-mcp@3.2.4`, `server-github@2025.4.8` |
| H-3 | `--frozen-lockfile` | both yml files | `pnpm install --frozen-lockfile` |
| H-5 | `/ask` auth | `server.ts:14-24` | `BOT_API_KEY` bearer token middleware |
| H-6 | Error response masking | `server.ts:38-40` | `requestId` only, no internals |
| H-7 | `fetchLastComment` pagination | `refresh-embeddings.ts:52` | `per_page=100`, `findLast()` |
| H-8 | `emb.index` bounds check | `refresh-embeddings.ts:97` | `throw new Error(...)` on out-of-range |
| H-9 | `JSON.stringify(undefined)` guard | `agent.ts:104` | `raw == null ? ''` fallback |
| M-1 | `{{` escape in all tool output | `agent.ts:96,113` | `esc()` applied in `truncateToolResult` |
| S-1 | Slack thread integration | `issue-reply.yml` | 4-step pipeline: preview → generate → thread → GH comment |
| E-1 | Embedding quality split | `embeddings.ts`, `refresh-embeddings.ts` | resolved:71 / open:13 separate files |
| E-2 | `semantic_search` DynamicTool | `agent.ts:119` | LangChain `DynamicTool` registered as 5th tool |

---

## Post-PR Backlog

### P1 — Dynamic SDK source retrieval ✅ merged

Agent system prompt now directs LLM to call `github__get_file_contents` for:
- Model name questions → `packages/core/src/model-types.ts`
- TemplateRef / messages_history questions → `packages/orchestration/src/util/module-config.ts`
- SEC-4: prohibit re-fetching the issue currently being answered (secondary injection vector)

Knowledge fix: reasoning model `max_tokens` → `max_completion_tokens` conversion documented in `knowledge.ts`.

---

### P2 — Operational hardening (post-PR)

#### throwOnLoadError: false
**File:** `src/agent.ts:52`  
**Problem:** If either MCP server fails to start, the entire bot crashes. A Context7 or GitHub API outage makes the bot completely unavailable.  
**Fix:**
```typescript
const mcpClient = new MultiServerMCPClient({
  throwOnLoadError: false,  // partial degradation instead of total failure
  ...
});
```
**Impact:** If one MCP is down, the bot answers with the remaining tools.

---

#### MAX_ITER 8 → 12 + synthesis on exhaustion
**File:** `src/agent.ts:11`  
**Problem:** Complex enterprise questions (BTP + resourceGroup + document-grounding combinations) can hit 8 iterations without a final answer. Currently returns silently incomplete response.  
**Fix:**
```typescript
const MAX_ITER = 12;

// in askBot(), before the final AIMessage guarantee:
if (i === MAX_ITER - 1 && response.tool_calls?.length) {
  messages.push(new HumanMessage(
    'You have reached the research limit. Synthesize the best answer from what you found so far.'
  ));
}
```

---

### P3 — Answer quality (post-PR)

#### orchestration vs langchain distinction
**File:** `src/agent.ts` — `AGENT_SYSTEM_PROMPT` Answer rules section  
**Problem:** Bot answers sometimes mix `@sap-ai-sdk/orchestration` (direct) and `@sap-ai-sdk/langchain` (wrapper) behaviors without clarifying which applies. Observed in test issue #44.  
**Fix:** Add to answer rules:
```
- Always clarify which package the answer applies to:
  @sap-ai-sdk/orchestration (direct client),
  @sap-ai-sdk/langchain (LangChain wrapper),
  or @sap-ai-sdk/foundation-models (Azure OpenAI direct).
  Behaviors differ — never mix examples without labeling.
```

---

#### prompt-registry README retrieval
**File:** `src/agent.ts` — `AGENT_SYSTEM_PROMPT` Dynamic source retrieval section  
**Problem:** Bot has no guidance on `@sap-ai-sdk/prompt-registry` or `@sap-ai-sdk/document-grounding`. Observed knowledge gap in test issue #47.  
**Fix:** Add to Dynamic source retrieval:
```
- PROMPT REGISTRY / TemplateRef QUESTIONS:
  call github__get_file_contents with owner="SAP", repo="ai-sdk-js",
  path="packages/prompt-registry/README.md"
- DOCUMENT GROUNDING / RAG QUESTIONS:
  call github__get_file_contents with owner="SAP", repo="ai-sdk-js",
  path="packages/document-grounding/README.md"
```

---

### P4 — Infrastructure (long-term)

#### Deployed model auto-sync
**Problem:** `knowledge.ts` model name list is manually maintained → goes stale on every SAP AI Core model add/remove.  
**Recommended approach (A):** Fetch at `initAgent()` startup via `@sap-ai-sdk/ai-api`:
```typescript
import { DeploymentApi } from '@sap-ai-sdk/ai-api';
const deployments = await DeploymentApi.deploymentQuery({ status: 'RUNNING' }).execute();
// inject into AGENT_SYSTEM_PROMPT
```
**Alternative (B):** `scripts/refresh-models.ts` + `src/deployed-models.json` + weekly cron (tolerates staleness, no startup overhead).

---

#### Slack action migration
Replace raw `curl` in `issue-reply.yml` with `slackapi/slack-github-action@v3.0.5` — same version already used in `e2e-tests.yml`. No secret changes needed.

---

## Validation commands

```bash
# Type check
pnpm build

# Embedding index integrity
node -e "
const r = JSON.parse(require('fs').readFileSync('src/embeddings-resolved.json','utf8'));
const o = JSON.parse(require('fs').readFileSync('src/embeddings-open.json','utf8'));
console.log('resolved:', r.length, '| all have resolution:', r.every(e=>e.resolution));
console.log('open:', o.length, '| all state=open:', o.every(e=>e.state==='open'));
console.log('no overlap:', !r.some(re=>o.some(op=>op.number===re.number)));
"

# Auth check
BOT_API_KEY=test123 pnpm serve &
curl -s -X POST http://localhost:3000/ask -H "Content-Type: application/json" \
  -d '{"question":"test"}' | jq .
# → {"error":"Unauthorized"}
```
