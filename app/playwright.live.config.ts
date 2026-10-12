import { defineConfig, devices } from "@playwright/test";

// Drives an already running demo and validator; nothing here is mocked.
export default defineConfig({
  testDir: "./tests/live",
  timeout: 180000,
  use: { baseURL: process.env.LIVE_URL ?? "http://127.0.0.1:3000", trace: "retain-on-failure" },
  // Each successful run consumes the permission, so pick one project per reset.
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" as const } },
  ].filter((project) => project.name === (process.env.LIVE_PROJECT ?? "desktop")),
});
