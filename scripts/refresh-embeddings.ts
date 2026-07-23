import { OrchestrationEmbeddingClient } from '@sap-ai-sdk/orchestration';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GH_TOKEN = process.env.GITHUB_TOKEN;
if (!GH_TOKEN) throw new Error('GITHUB_TOKEN is required');

const BATCH = 20;
const BASE = dirname(fileURLToPath(import.meta.url));
const OUT_RESOLVED = join(BASE, '../src/embeddings-resolved.json');
const OUT_OPEN     = join(BASE, '../src/embeddings-open.json');
const GH_HEADERS = { Authorization: `Bearer ${GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' };

type GHIssue   = { number: number; title: string; state: string; body?: string; pull_request?: unknown };
type GHComment = { body?: string; user?: { login?: string; type?: string } };
type IndexEntry = { number: number; title: string; state: string; resolution?: string; embedding: number[] };

function extractBugDescription(body: string): string {
  // ponytail: two simple patterns instead of one backtracking [\s\S]*?(?=###|$)
  const headingRe = /###\s*(?:Describe the Bug|Describe the Question)\s*\n/i;
  const match = headingRe.exec(body);
  if (!match) return '';
  const after = body.slice(match.index + match[0].length);
  const end = after.indexOf('\n###');
  return (end === -1 ? after : after.slice(0, end)).trim().slice(0, 200);
}

async function fetchAllIssues(): Promise<GHIssue[]> {
  const issues: GHIssue[] = [];
  let page = 1;
  while (true) {
    const resp = await fetch(
      `https://api.github.com/repos/SAP/ai-sdk-js/issues?state=all&per_page=100&page=${page}`,
      { headers: GH_HEADERS }
    );
    if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
    const batch = (await resp.json()) as GHIssue[];
    if (!batch.length) break;
    issues.push(...batch.filter(i => !i.pull_request));
    if (batch.length < 100) break;
    page++;
  }
  return issues;
}

// Returns the last human comment body (truncated), or undefined if none.
// H-7: per_page=100&direction=desc to get the actual last comment (not just first 30)
// Medium-4: filter by user.type !== 'Bot' in addition to [bot] login check
async function fetchLastComment(issueNumber: number): Promise<string | undefined> {
  const resp = await fetch(
    `https://api.github.com/repos/SAP/ai-sdk-js/issues/${issueNumber}/comments?per_page=100&direction=desc`,
    { headers: GH_HEADERS }
  );
  if (!resp.ok) return undefined;
  const comments = (await resp.json()) as GHComment[];
  const last = comments.findLast(
    c => c.user?.type !== 'Bot' && !c.user?.login?.includes('[bot]') && c.body?.trim()
  );
  if (!last?.body) return undefined;
  // Medium-5: slice by code point to avoid splitting Unicode surrogate pairs
  return Array.from(last.body.replace(/\s+/g, ' ').trim()).slice(0, 300).join('');
}

const client = new OrchestrationEmbeddingClient({
  embeddings: { model: { name: 'text-embedding-3-large' } }
});

async function main() {
  console.error('Fetching issues from SAP/ai-sdk-js...');
  const issues = await fetchAllIssues();
  console.error(`Found ${issues.length} issues (excluding PRs)`);

  // Fetch resolution (last human comment) for closed issues
  const closed = issues.filter(i => i.state === 'closed');
  console.error(`Fetching resolutions for ${closed.length} closed issues...`);
  const resolutions = new Map<number, string>();
  for (const iss of closed) {
    const res = await fetchLastComment(iss.number);
    if (res) resolutions.set(iss.number, res);
  }
  console.error(`  ${resolutions.size} resolutions found`);

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
      // H-8: strict bounds check — ?? 0 would silently corrupt the index
      const iss = batch[emb.index];
      if (!iss) throw new Error(`Embedding index ${emb.index} out of range for batch of ${batch.length}`);
      entries.push({
        number: iss.number,
        title:  iss.title,
        state:  iss.state,
        resolution: resolutions.get(iss.number),
        embedding: emb.embedding as number[]
      });
    }
    console.error(`  embedded ${Math.min(i + BATCH, issues.length)}/${issues.length}`);
  }

  // Item 2: quality-based split — resolved (closed+resolution) vs open
  const resolved = entries.filter(e => e.state === 'closed' && e.resolution);
  const open     = entries.filter(e => e.state === 'open');

  writeFileSync(OUT_RESOLVED, JSON.stringify(resolved, null, 2));
  writeFileSync(OUT_OPEN,     JSON.stringify(open,     null, 2));
  console.error(`Written: ${resolved.length} resolved → embeddings-resolved.json`);
  console.error(`         ${open.length} open     → embeddings-open.json`);
}

await main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
