import { initAgent, closeAgent, askBot } from './agent.js';

// GitHub Action passes title and body as separate args
const title = process.argv[2];
const rawBody = process.argv[3] ?? '';

if (!title) {
  console.error('Usage: tsx src/reply.ts "<title>" ["<body>"]');
  process.exit(1);
}

// ── GitHub issue body parser ──────────────────────────────────────────────────

function extractSection(body: string, heading: string): string {
  const re = new RegExp(`###\\s*${heading}\\s*\\n([\\s\\S]*?)(?=###|$)`, 'i');
  return body.match(re)?.[1]?.trim() ?? '';
}

function extractErrorMessages(body: string): string[] {
  const results: string[] = [];

  // JSON error.message fields: "message":"..."
  for (const m of body.matchAll(/"message"\s*:\s*"([^"]{10,200})"/g)) {
    results.push(m[1]);
  }

  // Thrown error lines: "Error: ..." or "✗ FAIL: ..."
  for (const m of body.matchAll(/(?:Error|FAIL)[:\s]+([^\n]{10,150})/g)) {
    results.push(m[1].trim());
  }

  return [...new Set(results)].slice(0, 3);
}

function stripBoilerplate(body: string): string {
  return body
    .replace(/###\s*Checklist[\s\S]*?(?=###|$)/i, '')
    .replace(/###\s*(Screenshots|Log File|Additional Context|Timeline)\s*[\s\S]*?(?=###|$)/gi, '')
    .replace(/\s*_No response_\s*/g, '')
    .trim();
}

function truncateCodeBlocks(body: string, maxChars = 200): string {
  return body.replace(/```[\s\S]*?```/g, block => {
    const inner = block.slice(3, -3).trim();
    return inner.length > maxChars
      ? '```\n' + inner.slice(0, maxChars) + '\n... (truncated)\n```'
      : block;
  });
}

function parseIssueBody(body: string) {
  const bugDescription = extractSection(body, 'Describe the Bug')
    || extractSection(body, 'Describe the Question');
  const errorMessages = extractErrorMessages(body);
  const cleanBody = truncateCodeBlocks(stripBoilerplate(body));

  return { bugDescription, errorMessages, cleanBody };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const { bugDescription, errorMessages, cleanBody } = parseIssueBody(rawBody);

// Prepend error messages to body so agent.ts extracts them in search queries
const enrichedBody = [
  bugDescription || cleanBody,
  errorMessages.length ? `Error: ${errorMessages.join(' | ')}` : ''
].filter(Boolean).join('\n\n');

await initAgent();
const answer = await askBot(title, enrichedBody || undefined, errorMessages);
await closeAgent();

// Output only the answer — captured by GitHub Action
process.stdout.write(answer);
