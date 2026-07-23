import { OrchestrationEmbeddingClient } from '@sap-ai-sdk/orchestration';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX_PATH = join(dirname(fileURLToPath(import.meta.url)), 'issue-embeddings.json');

type IndexEntry = { number: number; title: string; state: string; embedding: number[] };
type IssueRef = { number: number; title: string; state: string; body?: string };

let index: IndexEntry[] = [];

const embeddingClient = new OrchestrationEmbeddingClient({
  embeddings: { model: { name: 'text-embedding-3-large' } }
});

export function loadEmbeddingIndex(): void {
  try {
    const entries = JSON.parse(readFileSync(INDEX_PATH, 'utf8')) as IndexEntry[];
    index = entries;
    if (index.length) {
      console.error(`  embeddings  ${index.length} issues indexed`);
    }
  } catch {
    // ponytail: no index yet — semantic search disabled silently
  }
}

// ponytail: O(n) cosine scan, sufficient for <1k issues; swap to hnswlib-node if needed
function cosine(a: number[], b: number[]): number {
  let dot = 0, mA = 0, mB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    mA += a[i] * a[i];
    mB += b[i] * b[i];
  }
  return dot / (Math.sqrt(mA) * Math.sqrt(mB) || 1);
}

export async function semanticSearch(query: string, topK = 5): Promise<IssueRef[]> {
  if (!index.length) return [];
  try {
    const resp = await embeddingClient.embed({ input: query });
    const vec = resp.getEmbeddings()[0].embedding as number[];
    return index
      .map(e => ({ ...e, score: cosine(vec, e.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ number, title, state }) => ({ number, title, state }));
  } catch {
    return [];
  }
}
