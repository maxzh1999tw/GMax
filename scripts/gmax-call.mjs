// 開發用：從命令列呼叫打包後的 MCP 工具。用法：node scripts/gmax-call.mjs <工具> <JSON 或 @檔案>
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [tool, raw = '{}'] = process.argv.slice(2);
const args = JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw);
const client = new Client({ name: 'gmax-call', version: '1' });
const server = new URL('../plugin/server/gmax.mjs', import.meta.url);
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server.pathname.replace(/^\/([A-Za-z]:)/, '$1')], env: process.env }));
const result = await client.callTool({ name: tool, arguments: args });
console.log(result.content[0].text);
await client.close();
