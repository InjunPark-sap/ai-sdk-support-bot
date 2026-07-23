# Agent Pattern Migration Plan

## Status: IN PROGRESS

---

## Decision: Option A (Manual loop)

LangGraph 불필요. stateless single-turn에는 manual loop이 더 적합.

| | Option A (Manual) | Option B (LangGraph) |
|---|---|---|
| 코드량 | ~20줄 | ~30줄 |
| 새 의존성 | 없음 | package.json 수정 |
| 제어력 | 높음 (per-tool catch) | 낮음 |
| 적합성 | ✅ single-turn | ❌ human-in-the-loop용 |

---

## Architecture Change

### Before (Manual RAG)
```
askBot()
  → 8개 하드코딩 병렬 검색
  → dedup
  → get_issue top 3
  → 대형 system prompt 조립 (docs + issues + details)
  → LLM.invoke() 1회 — 합성만
```

### After (Agent)
```
askBot()
  → semanticSearch(title)  ← 로컬, 즉시
  → SystemMessage(AGENT_SYSTEM_PROMPT)
  → HumanMessage(title + body + errorMessages + semantic hints)
  → loop (max 8):
      LLM.invoke(messages)
      tool_calls? → 병렬 실행 → ToolMessages 추가
      no tool_calls? → break → 답변 반환
```

---

## New System Prompt (AGENT_SYSTEM_PROMPT)

```
{SDK_KNOWLEDGE}

## Tools available
- context7__query-docs  — search official SAP AI SDK documentation
- github__search_issues — search GitHub issues (repo SAP/ai-sdk-js)
- github__get_issue     — fetch full body of a specific issue by number
- github__search_code   — search code examples

## Required strategy — follow this order
1. ALWAYS call context7__query-docs first with the full question.
2. Call github__search_issues with relevant keywords.
   If error messages are provided, search those too.
3. If search results contain issues closely matching the problem,
   call github__get_issue for at most 3 of them.
4. Answer based only on what you retrieved. Do not invent API method names.

## Rules
- Cite doc section titles or GitHub issue numbers (#xxx) in your answer.
- If a feature is only in an open issue or unmerged PR, say so explicitly.
- End every answer with a "## Related Issues" section.
  Only include issues whose core topic matches.
  If none match, write "No related issues found."
- Only use issue numbers you actually retrieved via tools. Never invent numbers.
```

---

## truncateToolResult() — Single exit point for all tool output

```typescript
function truncateToolResult(raw: unknown, toolName: string): string {
  const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const limits: Record<string, number> = {
    'context7__query-docs': 4000,
    'github__get_issue': 800,
    'github__search_issues': 2000,
    'github__search_code': 2000,
  };
  const limit = limits[toolName] ?? 2000;
  return str.slice(0, limit).replace(/\{\{/g, '{ {');
}
```

---

## Token Budget (worst case)

```
docs (4000) + search×2 (2000×2) + get_issue×3 (800×3)
+ system prompt (~1000) + initial message (~500)
≈ 12,800 chars ≈ 3,200 tokens  ← 8k 한도 내 안전
```

---

## Step-by-Step Implementation

- [x] Step 1: `AGENT_SYSTEM_PROMPT` 상수 추가 (SDK_KNOWLEDGE import + tool 전략)
- [x] Step 2: `truncateToolResult()` 헬퍼 추가
- [x] Step 3: `modelWithTools` 모듈 변수화 (initAgent에서 bindTools)
- [x] Step 4: `askBot()` agent loop로 교체
- [x] Step 5: 불필요 코드 삭제 (~100줄: CONTEXT, PER_PAGE, extractKeywords 등)
- [x] Step 6: import 수정 (ToolMessage, BaseMessage 추가)
- [x] Step 7: `tsc --noEmit` 확인 ✅

---

## File Impact

| File | Change |
|------|--------|
| `src/agent.ts` | 전면 재작성 (~230줄 → ~130줄). 공개 API 동일 |
| `src/reply.ts` | 변경 없음 |
| `src/server.ts` | 변경 없음 |
| `src/cli.ts` | 변경 없음 |
| `src/embeddings.ts` | 변경 없음 |
| `src/knowledge.ts` | 변경 없음 |
| `package.json` | 변경 없음 |

---

## Public API (변경 없음)

```typescript
export async function initAgent(): Promise<void>
export async function closeAgent(): Promise<void>
export async function askBot(title: string, body?: string, errorMessages?: string[]): Promise<string>
```

---

## Risks & Mitigations

| 리스크 | 대응 |
|--------|------|
| LLM이 context7 건너뜀 | system prompt "ALWAYS first" 명시 |
| get_issue 너무 많이 호출 | 800자 cap + 최대 3개 권장 지시 |
| `{{ }}` escape 누락 | truncateToolResult 단일 지점 처리 |
| 잘못된 tool 이름 | per-tool .catch() → 에러 ToolMessage |

---

## Post-Migration Tasks

1. 전체 재테스트 (6종 이슈)
2. P2: Documentation 임베딩 (agent tool로 설계)
3. P2: GH issue learning summary
4. P3: llms.txt PR (SAP/ai-sdk-js)
