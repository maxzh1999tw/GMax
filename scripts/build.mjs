// 打包 MCP 成單一檔案，讓 plugin 安裝後不必再執行 npm install，並產生子代理設定
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { AGENTS, claudeAgent, codexAgent } from './agents.mjs';

mkdirSync('plugin/server', { recursive: true });
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'plugin/server/gmax.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});

mkdirSync('plugin/agents', { recursive: true });
mkdirSync('codex/agents', { recursive: true });
for (const a of AGENTS) {
  writeFileSync(`plugin/agents/${a.name}.md`, claudeAgent(a));
  writeFileSync(`codex/agents/${a.name}.toml`, codexAgent(a));
}
