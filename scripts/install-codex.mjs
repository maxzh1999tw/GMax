// 把 GMax 安裝到 Codex：MCP 設定、skill 與審查子代理
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const agentsHome = join(homedir(), '.agents');
const server = join(root, 'plugin', 'server', 'gmax.mjs');

if (!existsSync(server)) {
  console.error('找不到打包後的伺服器，請先執行 npm run build。');
  process.exit(1);
}

mkdirSync(join(codexHome, 'agents'), { recursive: true });
for (const file of readdirSync(join(root, 'codex', 'agents'))) {
  copyFileSync(join(root, 'codex', 'agents', file), join(codexHome, 'agents', file));
}

cpSync(join(root, 'plugin', 'skills', 'gmax-play'), join(agentsHome, 'skills', 'gmax-play'), { recursive: true });

const configPath = join(codexHome, 'config.toml');
const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
if (/^\[mcp_servers\.gmax\]/m.test(config)) {
  console.log('config.toml 已有 gmax 設定，未變更。');
} else {
  const block = `\n[mcp_servers.gmax]\ncommand = "node"\nargs = [${JSON.stringify(server)}]\n`;
  writeFileSync(configPath, config + block);
  console.log(`已加入 MCP 設定：${configPath}`);
}
console.log('GMax 已安裝到 Codex。注意：Codex 沒有遮罩功能，工具內容可能會顯示在畫面上。');
