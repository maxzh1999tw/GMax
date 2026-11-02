import { defineConfig } from 'vitest/config';

// plugin/hooks 的測試要用 claude plugin test 執行
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
