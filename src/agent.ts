import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { OrchestrationClient } from '@sap-ai-sdk/langchain';
import { loadEmbeddingIndex, semanticSearch } from './embeddings.js';
import { SDK_KNOWLEDGE } from './knowledge.js';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { BaseMessage } from '@langchain/core/messages';

const MAX_ITER = 8;

// Best match from context7 resolve: Benchmark 83, 532 snippets
const LIBRARY_ID = '/websites/sap_github_io_ai-sdk_js';

const AGENT_SYSTEM_PROMPT = [
  'You are an SAP AI SDK support assistant.',
  '',
  SDK_KNOWLEDGE,
  '',
  '## Tools available',
  '- context7__query-docs  — search official SAP AI SDK documentation (libraryId: "' + LIBRARY_ID + '")',
  '- github__search_issues — search GitHub issues (always use q: "repo:SAP/ai-sdk-js <keywords>")',
  '- github__get_issue     — fetch full body of a specific issue by number',
  '- github__search_code   — search code examples in the SAP AI SDK repository',
  '',
  '## Required strategy — follow this order every time',
  '1. ALWAYS call context7__query-docs first with the full question.',
  '2. Call github__search_issues with relevant keywords from the question.',
  '   If error messages are provided in the question, search for those too.',
  '3. If search results contain issues closely matching the problem (same API, same error type),',
  '   call github__get_issue for at most 3 of them to get full details.',
  '4. Answer based ONLY on what you retrieved. Do not invent API method names or issue numbers.',
  '',
  '## Answer rules',
  '- Cite doc section titles or GitHub issue numbers (#xxx) in your answer.',
  '- If a feature is only in an open issue or unmerged PR, say so explicitly — do not present it as available.',
  '- End EVERY answer with a "## Related Issues" section.',
  '  Only include issues whose CORE TOPIC matches (same API, same error type, same feature).',
  '  Sharing only a class name is NOT enough.',
  '  If none match, write "No related issues found."',
  '  Do NOT include dependency bumps or unrelated chore PRs.',
].join('\n');

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
let modelWithTools: ReturnType<typeof model.bindTools>;

const model = new OrchestrationClient({
  promptTemplating: { model: { name: 'anthropic--claude-4.5-haiku' } }
});

const parser = new StringOutputParser();

function getTool(name: string): StructuredToolInterface | undefined {
  return tools.find(t => t.name === name);
}

// Single exit point for all tool output — caps size and escapes {{ to prevent 400 errors
function truncateToolResult(raw: unknown, toolName: string): string {
  const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const limits: Record<string, number> = {
    'context7__query-docs': 4000,
    'github__get_issue': 800,
    'github__search_issues': 2000,
    'github__search_code': 2000
  };
  return str.slice(0, limits[toolName] ?? 2000).replace(/\{\{/g, '{ {');
}

export async function initAgent(): Promise<void> {
  tools = await mcpClient.getTools();
  modelWithTools = model.bindTools(tools);
  const group = (prefix: string) =>
    tools.filter(t => t.name.startsWith(prefix)).map(t => t.name.replace(prefix, '')).join(', ');
  console.error(`  context7  ${group('context7__')}`);
  console.error(`  github    ${group('github__')}`);
  loadEmbeddingIndex();
}

export async function closeAgent(): Promise<void> {
  await mcpClient.close();
}

export async function askBot(title: string, body?: string, errorMessages?: string[]): Promise<string> {
  if (!tools.length) throw new Error('Agent not initialized. Call initAgent() first.');

  // Pre-seed semantic hints (local cosine scan — zero latency, no round trip)
  const semanticHints = await semanticSearch(title);

  const parts = [
    `Question: ${title}`,
    body ?? null,
    errorMessages?.length
      ? `Error messages:\n${errorMessages.map(e => `- ${e}`).join('\n')}`
      : null,
    semanticHints.length
      ? `Potentially related issues (local index): ${semanticHints.map(i => `#${i.number} ${i.title}`).join(', ')}`
      : null
  ].filter(Boolean).join('\n\n');

  const messages: BaseMessage[] = [
    new SystemMessage(AGENT_SYSTEM_PROMPT),
    new HumanMessage(parts)
  ];

  for (let i = 0; i < MAX_ITER; i++) {
    const response = await modelWithTools.invoke(messages);
    messages.push(response);

    if (!response.tool_calls?.length) break;

    const toolMessages = await Promise.all(
      response.tool_calls.map(async tc => {
        const tool = getTool(tc.name);
        if (!tool) {
          return new ToolMessage({ content: `Unknown tool: ${tc.name}`, tool_call_id: tc.id ?? 'default' });
        }
        try {
          const raw = await tool.invoke(tc.args);
          return new ToolMessage({ content: truncateToolResult(raw, tc.name), tool_call_id: tc.id ?? 'default' });
        } catch (err) {
          return new ToolMessage({
            content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
            tool_call_id: tc.id ?? 'default'
          });
        }
      })
    );

    messages.push(...toolMessages);
  }

  return parser.invoke(messages.at(-1)!);
}
