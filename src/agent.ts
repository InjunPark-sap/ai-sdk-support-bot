import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { OrchestrationClient } from '@sap-ai-sdk/langchain';
import type { StructuredToolInterface } from '@langchain/core/tools';

// Context budget: SAP AI Core haiku has ~8k input token limit
// chars ≈ tokens * 4  →  docs:4000 chars + issues:2000 chars + prompt overhead ≈ safe
const CONTEXT = { DOCS: 4000, ISSUE_BODY: 150, MAX_ISSUES: 8 } as const;

// Best match from context7 resolve: Benchmark 83, 532 snippets
const LIBRARY_ID = '/websites/sap_github_io_ai-sdk_js';

const STOPWORDS = new Set([
  'error', 'issue', 'throws', 'returns', 'using', 'when', 'adding',
  'called', 'failed', 'cannot', 'does', 'with', 'that', 'this', 'from',
  'have', 'there', 'their', 'about', 'would', 'which', 'should', 'could',
  'after', 'before', 'while', 'where', 'getting', 'trying', 'calling',
  'working', 'works', 'between', 'difference', 'initialize', 'setting'
]);

const mcpClient = new MultiServerMCPClient({
  throwOnLoadError: true,
  prefixToolNameWithServerName: true,
  useStandardContentBlocks: true,
  mcpServers: {
    context7: {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@latest']
    },
    github: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN ?? '' }
    }
  }
});

let tools: StructuredToolInterface[] = [];

const model = new OrchestrationClient({
  promptTemplating: { model: { name: 'anthropic--claude-4.5-haiku' } }
});

const parser = new StringOutputParser();

function getTool(name: string): StructuredToolInterface {
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`MCP tool not found: ${name}`);
  return tool;
}

type IssueItem = { number: number; title: string; body?: string; state: string };

function parseIssues(raw: unknown): IssueItem[] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed?.items ?? parsed ?? [];
  } catch {
    return [];
  }
}

function dedupeAndFormat(lists: IssueItem[][]): string {
  const seen = new Set<number>();
  return lists
    .flat()
    .filter(i => !seen.has(i.number) && seen.add(i.number))
    .slice(0, CONTEXT.MAX_ISSUES)
    .map(i => `#${i.number} [${i.state}] ${i.title}\n${(i.body ?? '').slice(0, CONTEXT.ISSUE_BODY)}`)
    .join('\n\n');
}

// SAP AI SDK domain-specific terms that should always be preserved in search
const DOMAIN_TERMS = new Set([
  'masking', 'grounding', 'filtering', 'streaming', 'embedding', 'orchestration',
  'langchain', 'template', 'deployment', 'destination', 'resilience', 'caching'
]);

// SAP AI SDK class name prefixes — only these count as tech terms for in:title search
const SDK_PREFIXES = [
  'Orchestration', 'AzureOpenAi', 'Foundation', 'Embedding',
  'LangChain', 'Grounding', 'Document', 'Prompt', 'Masking'
];

// Split camelCase, filter stopwords — applied to title only for search queries
function extractKeywords(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && (!STOPWORDS.has(w.toLowerCase()) || DOMAIN_TERMS.has(w.toLowerCase())))
    .slice(0, 5)
    .join(' ');
}

// Only SDK class/package names — filters out common English words like "When", "How"
function extractTechTerms(text: string): string {
  const sdkClasses = [...text.matchAll(/\b[A-Z][a-zA-Z]{3,}\b/g)]
    .map(m => m[0])
    .filter(w => SDK_PREFIXES.some(p => w.startsWith(p)));
  const pkg = [...text.matchAll(/@[\w-]+\/[\w-]+/g)].map(m => m[0]);
  return [...new Set([...sdkClasses, ...pkg])].slice(0, 3).join(' ');
}

// Extract HTTP status code if present
function extractErrorCode(text: string): string | null {
  const match = text.match(/\b([45]\d{2})\b/);
  return match ? match[1] : null;
}

// Extract domain terms for in:title search
function extractDomainHits(text: string): string {
  return text.toLowerCase().split(/\s+/).filter(w => DOMAIN_TERMS.has(w)).slice(0, 2).join(' ');
}

export async function initAgent(): Promise<void> {
  tools = await mcpClient.getTools();
  const group = (prefix: string) =>
    tools.filter(t => t.name.startsWith(prefix)).map(t => t.name.replace(prefix, '')).join(', ');
  console.error(`  context7  ${group('context7__')}`);
  console.error(`  github    ${group('github__')}`);
}

export async function closeAgent(): Promise<void> {
  await mcpClient.close();
}

export async function askBot(title: string, body?: string, errorMessages?: string[]): Promise<string> {
  if (!tools.length) throw new Error('Agent not initialized. Call initAgent() first.');

  // Search queries: title only (body has code/stack traces that pollute search)
  // Docs query + LLM context: title + body (full context)
  const searchText = title;
  const fullQuestion = body ? `${title}\n\n${body}` : title;

  const keywords = extractKeywords(searchText);
  const techTerms = extractTechTerms(searchText);
  const errorCode = extractErrorCode(body ?? searchText);
  const domainHits = extractDomainHits(searchText);

  // errorMessages from parsed issue body — most precise search signal
  const errorQuery = errorMessages?.length
    ? errorMessages[0].replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 3).slice(0, 6).join(' ')
    : null;

  const [docsRaw, exactRaw, keywordRaw, techRaw, errorCodeRaw, domainRaw, errorMsgRaw] = await Promise.all([
    getTool('context7__query-docs').invoke({ libraryId: LIBRARY_ID, query: fullQuestion }),
    getTool('github__search_issues').invoke({ q: `repo:SAP/ai-sdk-js ${searchText}`, per_page: 5 }),
    getTool('github__search_issues').invoke({ q: `repo:SAP/ai-sdk-js ${keywords}`, per_page: 5 }),
    techTerms
      ? getTool('github__search_issues').invoke({ q: `repo:SAP/ai-sdk-js ${techTerms} in:title`, per_page: 5 })
      : Promise.resolve([]),
    errorCode
      ? getTool('github__search_issues').invoke({ q: `repo:SAP/ai-sdk-js ${errorCode} ${keywords}`, per_page: 5 })
      : Promise.resolve([]),
    domainHits
      ? getTool('github__search_issues').invoke({ q: `repo:SAP/ai-sdk-js ${domainHits} in:title`, per_page: 5 })
      : Promise.resolve([]),
    errorQuery
      ? getTool('github__search_issues').invoke({ q: `repo:SAP/ai-sdk-js ${errorQuery}`, per_page: 5 })
      : Promise.resolve([])
  ]);

  const rawDocs = typeof docsRaw === 'string' ? docsRaw : JSON.stringify(docsRaw);

  // Extract code snippets before slicing for a dedicated section
  const codeExamples = (rawDocs.match(/```[\s\S]*?```/g) ?? [])
    .slice(0, 3)
    .join('\n\n')
    .slice(0, 1500)
    .replace(/\{\{/g, '{ {');

  // Escape {{ everywhere — Orchestration service parses ALL {{?...}} in system prompt,
  // including inside code blocks. Display is slightly uglier but avoids 400 errors.
  const docs = rawDocs
    .slice(0, CONTEXT.DOCS)
    .replace(/\{\{/g, '{ {');

  const allIssues = dedupeAndFormat([
    parseIssues(exactRaw),
    parseIssues(keywordRaw),
    parseIssues(techRaw),
    parseIssues(errorCodeRaw),
    parseIssues(domainRaw),
    parseIssues(errorMsgRaw)
  ]);

  // Fetch full body of top 3 issues for solution details
  const topIssueNumbers = [
    ...parseIssues(exactRaw),
    ...parseIssues(keywordRaw),
    ...parseIssues(techRaw)
  ]
    .filter((v, i, a) => a.findIndex(x => x.number === v.number) === i)
    .slice(0, 3)
    .map(i => i.number);

  const issueDetails = (
    await Promise.all(
      topIssueNumbers.map(n =>
        getTool('github__get_issue')
          .invoke({ owner: 'SAP', repo: 'ai-sdk-js', issue_number: n })
          .then(raw => {
            const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const body = (d.body ?? '').slice(0, 600);
            return `#${d.number} [${d.state}] ${d.title}\n${body}`;
          })
          .catch(() => '')
      )
    )
  ).filter(Boolean).join('\n\n---\n\n');

  const systemPrompt = [
    'You are an SAP AI SDK support assistant.',
    'Answer ONLY based on the provided context below.',
    'Cite doc section titles or GitHub issue numbers (#xxx) in your answer.',
    'IMPORTANT: The SAP AI SDK uses these exact method names:',
    '  - OrchestrationClient: chatCompletion(), stream() — NOT streamChat()',
    '  - AzureOpenAiChatClient: run(), stream() — NOT streamChat()',
    '  If the documentation shows an incorrect method name, use the correct one above.',
    '',
    'At the end of EVERY answer, include a "## Related Issues" section.',
    'STRICT rules for Related Issues:',
    '- Only include issues where the CORE TOPIC matches the question (same API, same method, same error type).',
    '- Sharing only a class name or package name is NOT enough — the issue must be about the same problem or feature.',
    '- Do NOT include dependency bumps, chore PRs, or unrelated feature requests.',
    '- If no issues genuinely match, write "No related issues found." — do not force-include.',
    '- Do NOT invent issue numbers — only use issues explicitly listed in the context below.',
    '- Do NOT present open feature requests or unmerged PRs as existing functionality.',
    '  If an issue is open or a PR is not merged, clearly state it is not yet available.',
    '',
    '=== DOCUMENTATION ===',
    docs,
    '',
    codeExamples ? '=== CODE EXAMPLES FROM DOCS ===' : '',
    codeExamples,
    '',
    '=== GITHUB ISSUES (summary) ===',
    allIssues,
    '',
    issueDetails ? '=== ISSUE DETAILS (top matches) ===' : '',
    issueDetails
  ].filter(s => s !== undefined).join('\n');

  return parser.invoke(
    await model.invoke([new SystemMessage(systemPrompt), new HumanMessage(fullQuestion)])
  );
}

