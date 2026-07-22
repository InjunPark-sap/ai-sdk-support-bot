import * as readline from 'node:readline';
import { initAgent, closeAgent, askBot } from './agent.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function main() {
  console.log('');
  console.log('  SAP AI SDK Support Bot');
  console.log('  ──────────────────────────────────────');
  console.log('  Retrieval : Context7 (docs) + GitHub (issues)');
  console.log('  Model     : claude-4.5-haiku via SAP AI Core');
  console.log('  ──────────────────────────────────────');
  console.log('  Starting MCP servers...');
  await initAgent();
  console.log('  ──────────────────────────────────────');
  console.log('  Ready. Type your question below.');
  console.log('  Ctrl+C to exit.');
  console.log('');

  const ask = () => {
    rl.question('> ', async question => {
      if (!question.trim()) {
        ask();
        return;
      }
      try {
        const answer = await askBot(question);
        console.log('\n' + answer + '\n');
      } catch (err) {
        if (err instanceof Error) {
          console.error('Error:', err.message);
          const cause = (err as any).cause?.response?.data;
          if (cause) console.error('Cause:', JSON.stringify(cause, null, 2));
        } else {
          console.error('Error:', String(err));
        }
      }
      ask();
    });
  };

  ask();
}

rl.on('close', async () => {
  await closeAgent();
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
