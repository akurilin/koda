import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const artifactRoot =
  process.env.KODA_QA_ARTIFACTS_DIR ?? "/tmp/koda/playwright";
const qaPort = Number(process.env.PLAYWRIGHT_PORT);

if (!Number.isInteger(qaPort) || qaPort < 1 || qaPort > 65_535) {
  throw new Error(
    "PLAYWRIGHT_PORT must be a valid TCP port. Run the npm QA scripts so a port is assigned once for the whole Playwright run.",
  );
}

if (qaPort >= 3000 && qaPort <= 3005) {
  throw new Error("PLAYWRIGHT_PORT must not be between 3000 and 3005.");
}

const qaBaseUrl = `http://127.0.0.1:${qaPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: path.join(artifactRoot, "test-results"),
  reporter: [
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder: path.join(artifactRoot, "report"),
      },
    ],
  ],
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  use: {
    baseURL: qaBaseUrl,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npm run start -- --hostname 127.0.0.1 --port ${qaPort}`,
    url: qaBaseUrl,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
