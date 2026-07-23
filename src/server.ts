import express from 'express';
import { randomUUID } from 'node:crypto';
import { initAgent, closeAgent, askBot } from './agent.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const app = express();
app.disable('x-powered-by'); // suppress version disclosure header
app.use(express.json({ limit: '10kb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// H-5: static bearer token auth — skip if BOT_API_KEY not set (local dev)
app.use('/ask', (req, res, next) => {
  const key = process.env.BOT_API_KEY;
  if (key) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token !== key) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }
  next();
});

app.post('/ask', async (req, res) => {
  const { question } = req.body as { question?: string };
  if (!question?.trim() || question.length > 2000) {
    res.status(400).json({ error: 'question is required and must be under 2000 chars' });
    return;
  }
  try {
    const answer = await askBot(question);
    res.json({ answer });
  } catch (err) {
    // H-6: never leak internal error details (SAP AI Core URLs, tenant info, etc.)
    const requestId = randomUUID();
    console.error(`[${requestId}]`, err);
    res.status(500).json({ error: 'Internal server error', requestId });
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
