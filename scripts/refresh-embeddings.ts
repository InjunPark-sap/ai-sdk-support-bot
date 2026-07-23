import { OrchestrationEmbeddingClient } from '@sap-ai-sdk/orchestration';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GH_TOKEN = process.env.GITHUB_TOKEN;
if (!GH_TOKEN) throw new Error('GITHUB_TOKEN is required');

const BATCH = 20;
const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), '../src/issue-embeddings.json');

type GHIssue = { number: number; title: string; state: string; body?: string; pull_request?: unknown };
type IndexEntry = { number: number; title: string; state: string; embedding: number[] };

function extractBugDescription(body: string): string {
  const re = /###\s*(?:Describe the Bug|Describe the Question)\s*\n([\s\S]*?)(?=###|$)/i;
  return (body.match(re)?.[1] ?? '').trim().slice(0, 200);
}

async function fetchAllIssues(): Promise<GHIssue[]> {
  const issues: GHIssue[] = [];
  let page = 1;
  while (true) {
    const resp = await fetch(
      `https://api.github.com/repos/SAP/ai-sdk-js/issues?state=all&per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' } }
    );
    if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
    const batch = (await resp.json()) as GHIssue[];
    if (!batch.length) break;
    // exclude PRs (GitHub issues API returns PRs too)
    issues.push(...batch.filter(i => !i.pull_request));
    if (batch.length < 100) break;
    page++;
  }
  return issues;
}

const client = new OrchestrationEmbeddingClient({
  embeddings: { model: { name: 'text-embedding-3-large' } }
});

async function main() {
  console.error('Fetching issues from SAP/ai-sdk-js...');
  const issues = await fetchAllIssues();
  console.error(`Found ${issues.length} issues (excluding PRs)`);

  const entries: IndexEntry[] = [];

  for (let i = 0; i < issues.length; i += BATCH) {
    const batch = issues.slice(i, i + BATCH);
    const texts = batch.map(iss => {
      const bugDesc = extractBugDescription(iss.body ?? '');
      return bugDesc ? `${iss.title}\n${bugDesc}` : iss.title;
    });
    const resp = await client.embed({ input: texts });
    const embeddings = resp.getEmbeddings();
    for (const emb of embeddings) {
      const iss = batch[emb.index ?? 0];
      entries.push({
        number: iss.number,
        title: iss.title,
        state: iss.state,
        embedding: emb.embedding as number[]
      });
    }
    console.error(`  embedded ${Math.min(i + BATCH, issues.length)}/${issues.length}`);
  }

  writeFileSync(OUT_PATH, JSON.stringify(entries, null, 2));
  console.log(`Written ${entries.length} entries to src/issue-embeddings.json`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
