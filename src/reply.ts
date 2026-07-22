import { initAgent, closeAgent, askBot } from './agent.js';

const question = process.argv[2];
if (!question) {
  console.error('Usage: tsx src/reply.ts "<question>"');
  process.exit(1);
}

await initAgent();
const answer = await askBot(question);
await closeAgent();

// Output only the answer — captured by GitHub Action
process.stdout.write(answer);
