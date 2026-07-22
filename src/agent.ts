import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { OrchestrationClient } from '@sap-ai-sdk/langchain';
import type { StructuredToolInterface } from '@langchain/core/tools';

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
      env: {
        ...process.env,
        GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN ?? ''
      }
    }
  }
});

let tools: StructuredToolInterface[] = [];

const model = new OrchestrationClient({
  promptTemplating: {
    model: { name: 'anthropic--claude-4.5-haiku' }
  }
});

// Best match from context7 resolve: Benchmark 83, 532 snippets
const LIBRARY_ID = '/websites/sap_github_io_ai-sdk_js';

function getTool(name: string): StructuredToolInterface {
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`MCP tool not found: ${name}`);
  return tool;
}

function summarizeIssues(raw: unknown): string {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const items: { number: number; title: string; body?: string; state: string }[] =
      parsed?.items ?? parsed ?? [];
    return items
      .slice(0, 3)
      .map(i => `#${i.number} [${i.state}] ${i.title}\n${(i.body ?? '').slice(0, 300)}`)
      .join('\n\n');
  } catch {
    return typeof raw === 'string' ? raw.slice(0, 1500) : '';
  }
}

export async function initAgent(): Promise<void> {
  tools = await mcpClient.getTools();
  const context7Tools = tools.filter(t => t.name.startsWith('context7__'));
  const githubTools = tools.filter(t => t.name.startsWith('github__'));
  console.log(`  context7  ${context7Tools.length} tools: ${context7Tools.map(t => t.name.replace('context7__', '')).join(', ')}`);
  console.log(`  github    ${githubTools.length} tools: ${githubTools.map(t => t.name.replace('github__', '')).join(', ')}`);
}

export async function closeAgent(): Promise<void> {
  await mcpClient.close();
}

export async function askBot(question: string): Promise<string> {
  if (!tools.length) {
    throw new Error('Agent not initialized. Call initAgent() first.');
  }

  // Step 1: fetch relevant docs (library ID hardcoded — most reliable JS SDK source)
  const docsResult = await getTool('context7__query-docs').invoke({
    libraryId: LIBRARY_ID,
    query: question
  });
  const docs = (typeof docsResult === 'string' ? docsResult : JSON.stringify(docsResult))
    .slice(0, 4000);

  // Step 2: search GitHub issues — extract only title+number+body to minimize tokens
  const issuesResult = await getTool('github__search_issues').invoke({
    q: `repo:SAP/ai-sdk-js ${question}`,
    per_page: 3
  });
  const issues = summarizeIssues(issuesResult);

  // Step 3: synthesize with LLM
  const parser = new StringOutputParser();
  const systemPrompt =
    'You are an SAP AI SDK support assistant. ' +
    'Answer ONLY based on the provided context below. ' +
    'Cite doc section titles or GitHub issue numbers (#xxx) in your answer.\n' +
    'If the question is about a specific issue or error, find similar issues in the context below ' +
    'and include them under a "Similar Issues" section at the end of your answer.\n\n' +
    '=== DOCUMENTATION ===\n' + docs + '\n\n' +
    '=== GITHUB ISSUES ===\n' + issues;

  return parser.invoke(
    await model.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(question)
    ])
  );
}

