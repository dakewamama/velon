import { expect, test } from "@playwright/test";
import { object, readJson, writeJson } from "../../src/wire.ts";

test("native subscriptions scan, evidence and state comparison", async ({ page }, info) => {
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Who can act on this account" })).toBeVisible();
  await page.getByRole("button", { name: "Merchant", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Modify authority under the recorded constraints" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "View earlier slot 108" }).click();
  await expect(page.getByRole("heading", { name: /Spend up to 100 base units every hour/ })).toBeVisible();
  await expect(page.getByText("40 base units remain at this observation.")).toBeVisible();
  const spending = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: /Spend up to 100/ }) });
  await spending.getByRole("button", { name: "View details" }).click();
  await expect(
    page.getByText("These principals share one permission and one allowance.", { exact: false }),
  ).toBeVisible();
  await page.getByText("Exact ARM authorization", { exact: true }).click();
  await expect(
    page
      .locator("#detail details")
      .filter({ has: page.getByText("Exact ARM authorization", { exact: true }) })
      .locator("pre"),
  ).toContainText('"remaining": 40');
  await page.screenshot({ path: `test-results/${info.project.name}-detail.png`, fullPage: true });
  await page.getByRole("button", { name: "What changed", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Observed changes: slot 108 → 122" })).toBeVisible();
  await expect(
    page.locator("#diff article").filter({ hasText: "removed" }).filter({ hasText: "derived authority" }),
  ).toHaveCount(1);
  await page.screenshot({ path: `test-results/${info.project.name}-diff.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("large native amount, partial coverage and SPL reuse", async ({ page }, info) => {
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: /Spend up to 18,446,744,073,709,551/ })).toBeVisible();
  await expect(page.getByText("fixture evidence · slot 122 · Partial coverage")).toBeVisible();
  // Availability is the runtime's evaluation; a conditional grant is never counted as active.
  await expect(page.locator("#results .availability")).toHaveText("In force, within its limits");
  await expect(page.locator(".summary")).toContainText("1Permissions found");
  await expect(page.locator(".summary")).not.toContainText("Active");
  await page.screenshot({ path: `test-results/${info.project.name}-scan.png`, fullPage: true });
  await page.locator("#scenario").selectOption("1");
  await expect(page.getByRole("heading", { name: "Spend up to 25 base units in total" })).toBeVisible();
  await page.getByRole("button", { name: "What changed", exact: true }).click();
  await expect(page.getByText("This fixture has one observation.", { exact: false })).toBeVisible();
});

test("empty, invalid, failed and conflicting observations suppress stale grants", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Who can act on this account" })).toBeVisible();
  await page.locator("#address").fill("11111111111111111111111111111111");
  await page.locator("#scan").click();
  await expect(
    page.getByText("No permissions found in the state that was read", { exact: false }),
  ).toBeVisible();
  await page.locator("#address").fill("invalid");
  await page.locator("#scan").click();
  await expect(page.getByText("Enter a valid Solana address.")).toBeVisible();
  await expect(page.locator("#results article")).toHaveCount(0);
  await page.route("**/api/scopes/*/effective/*", (route) => route.fulfill({ status: 409 }));
  await page.getByRole("button", { name: "Source account", exact: true }).click();
  await expect(page.getByText("Conflicting observations at the same slot.", { exact: false })).toBeVisible();
  await expect(page.locator("#results article")).toHaveCount(0);
  await page.unroute("**/api/scopes/*/effective/*");
  await page.route("**/api/scopes/*/effective/*", (route) => route.fulfill({ status: 502 }));
  await page.locator("#scan").click();
  await expect(page.getByText("The observation provider is unavailable.", { exact: false })).toBeVisible();
});

test("unsupported native state remains unsupported", async ({ page }) => {
  await page.route("**/api/scopes/*/effective/*", async (route) => {
    const response = await route.fetch();
    const body = object(readJson(await response.text()));
    body.projection = { status: "unsupported", reason: "unknown deployment" };
    await route.fulfill({ response, body: writeJson(body) });
  });
  await page.goto("/app");
  await expect(page.getByText("Permission interpretation is unsupported: unknown deployment")).toBeVisible();
  await expect(page.locator("#results article")).toHaveCount(0);
});
