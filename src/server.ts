import express from 'express';
import { initAgent, closeAgent, askBot } from './agent.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/ask', async (req, res) => {
  const { question } = req.body as { question?: string };
  if (!question?.trim()) {
    res.status(400).json({ error: 'question is required' });
    return;
  }
  try {
    const answer = await askBot(question);
    res.json({ answer });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

console.log('');
console.log('  SAP AI SDK Support Bot — HTTP Server');
console.log('  ──────────────────────────────────────');
console.log('  POST /ask   { question: string } → { answer: string }');
console.log('  GET  /health                     → { status: "ok" }');
console.log('  ──────────────────────────────────────');
console.log('  Starting MCP servers...');

await initAgent();

app.listen(PORT, () => {
  console.log(`  Listening on http://localhost:${PORT}`);
  console.log('  ──────────────────────────────────────');
  console.log('');
});

process.on('SIGINT', async () => {
  await closeAgent();
  process.exit(0);
});
