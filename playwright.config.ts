import { defineConfig, devices } from "@playwright/test";

const isCi = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: {
    timeout: 20_000
  },
  fullyParallel: false,
  retries: isCi ? 1 : 0,
  workers: isCi ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"]
      }
    }
  ],
  webServer: [
    {
      command:
        "npm run build -w @local-terminal/shared && npm run build -w @local-terminal/security && npm run dev -w @local-terminal/gateway",
      url: "http://127.0.0.1:8787/api/health",
      reuseExistingServer: !isCi,
      timeout: 120_000
    },
    {
      command:
        "sh -c 'until [ -f packages/shared/dist/index.js ] && [ -f packages/security/dist/index.js ]; do sleep 0.2; done; npm run dev -w @local-terminal/web -- --host 127.0.0.1 --port 5173'",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !isCi,
      timeout: 120_000
    }
  ]
});
