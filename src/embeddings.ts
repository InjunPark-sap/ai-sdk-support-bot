import { OrchestrationEmbeddingClient } from '@sap-ai-sdk/orchestration';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = dirname(fileURLToPath(import.meta.url));
const RESOLVED_PATH = join(BASE, 'embeddings-resolved.json');
const OPEN_PATH     = join(BASE, 'embeddings-open.json');

type IndexEntry = { number: number; title: string; state: string; resolution?: string; embedding: number[] };
type IssueRef   = { number: number; title: string; state: string; resolution?: string };

let resolvedIndex: IndexEntry[] = [];
let openIndex:     IndexEntry[] = [];

const embeddingClient = new OrchestrationEmbeddingClient({
  embeddings: { model: { name: 'text-embedding-3-large' } }
});

function loadFile(path: string): IndexEntry[] {
  try {
    const entries = JSON.parse(readFileSync(path, 'utf8')) as IndexEntry[];
    if (!Array.isArray(entries)) throw new Error('not an array');
    return entries;
  } catch (err) {
    console.error('embeddings: failed to load', path, err);
    return [];
  }
}

export function loadEmbeddingIndex(): void {
  resolvedIndex = loadFile(RESOLVED_PATH);
  openIndex     = loadFile(OPEN_PATH);

  // Validate resolved index — every entry must have resolution
  const invalid = resolvedIndex.filter(e => !e.resolution);
  if (invalid.length) {
    console.error(`warn: ${invalid.length} resolved entries missing resolution field`);
  }

  if (resolvedIndex.length || openIndex.length) {
    console.error(`  embeddings  ${resolvedIndex.length} resolved, ${openIndex.length} open`);
  }
}

// ponytail: O(n) cosine scan, sufficient for <1k issues; swap to hnswlib-node if needed
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0; // dimension mismatch → exclude from ranking
  let dot = 0, mA = 0, mB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    mA += a[i] * a[i];
    mB += b[i] * b[i];
  }
  return dot / (Math.sqrt(mA) * Math.sqrt(mB) || 1);
}

export async function semanticSearch(query: string, topK = 5): Promise<IssueRef[]> {
  const combined = [...resolvedIndex, ...openIndex];
  if (!combined.length) return [];
  try {
    const resp = await embeddingClient.embed({ input: query });
    const vec = resp.getEmbeddings()[0].embedding as number[];
    return combined
      .map(e => ({ ...e, score: cosine(vec, e.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ number, title, state, resolution }) => ({ number, title, state, resolution }));
  } catch {
    return [];
  }
}
