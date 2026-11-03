// MCP over stdio, for Claude Desktop and other local MCP clients.
//
//   TALENTFLOW_TOKEN=<your API token> node src/mcp-stdio.js
//
// The token comes from the "AI assistants" page and decides which user the
// assistant acts as. Logs go to stderr; stdout carries only JSON-RPC.

import { createInterface } from 'node:readline';
import { openDb } from './db.js';
import { Scheduler } from './scheduler.js';
import { McpSession } from './mcp.js';

const db = openDb();
const scheduler = new Scheduler(db);
const user = scheduler.userByToken(process.env.TALENTFLOW_TOKEN);
if (!user) {
  console.error('TALENTFLOW_TOKEN is missing or invalid. Copy your token from the AI assistants page (npm start, then open http://localhost:4300).');
  process.exit(1);
}
const session = new McpSession(scheduler, user);
console.error(`TalentFlow MCP (stdio) acting as ${user.name} <${user.email}>`);

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  for (const m of Array.isArray(msg) ? msg : [msg]) {
    const res = session.handle(m);
    if (res) send(res);
  }
});
