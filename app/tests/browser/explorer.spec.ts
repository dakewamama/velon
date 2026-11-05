import { expect, test } from "@playwright/test";
import { object, readJson, writeJson } from "../../src/wire.ts";

// The forest page's light text, which every line outside a cream card must use.
const ON_FOREST = "rgb(238, 245, 241)";
const ON_FOREST_2 = "rgb(169, 194, 184)";

test("native subscriptions scan, evidence and state comparison", async ({ page }, info) => {
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Who can act on this account" })).toBeVisible();
  await expect(page.locator(".section-heading h2")).toHaveCSS("color", ON_FOREST);
  await expect(page.locator(".section-heading .link-button")).toHaveCSS("color", ON_FOREST);
  // The words the cards use are explained once, next to the list.
  await page.locator(".glossary summary").click();
  for (const term of ["Approval", "Token account", "Subscription", "Remove access"])
    await expect(page.locator(".glossary dt", { hasText: term }).first()).toBeVisible();
  await page.getByRole("button", { name: "Merchant", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: /owns this subscription plan and can change who is allowed to charge through it/,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "View earlier slot 108" }).click();
  // An earlier observation is told in the past tense, with no availability claimed for it.
  await expect(
    page.getByRole("heading", { name: /could charge up to 100 of this token's smallest units every hour/ }),
  ).toBeVisible();
  const spending = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: /could charge up to 100/ }) });
  await expect(spending.locator(".availability")).toHaveText("Earlier state");
  await spending.getByRole("button", { name: "Technical details" }).click();
  await expect(spending.locator(".field", { hasText: "Left when Velon read it" })).toContainText(
    "40 base units",
  );
  await expect(
    page.getByText("These principals share one permission and one allowance.", { exact: false }),
  ).toBeVisible();
  await page.getByText("Exact ARM authorization", { exact: true }).click();
  await expect(
    page
      .locator(".technical details")
      .filter({ has: page.getByText("Exact ARM authorization", { exact: true }) })
      .locator("pre"),
  ).toContainText('"remaining": 40');
  await page.screenshot({ path: `test-results/${info.project.name}-detail.png`, fullPage: true });
  await page.getByRole("button", { name: "What changed", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Observed changes: slot 108 → 122" })).toBeVisible();
  await expect(
    page
      .locator("#diff article")
      .filter({ hasText: "removed" })
      .filter({ hasText: "Acts through another permission" }),
  ).toHaveCount(1);
  await page.screenshot({ path: `test-results/${info.project.name}-diff.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("large native amount, partial coverage and SPL reuse", async ({ page }, info) => {
  await page.goto("/app");
  await expect(
    page.getByRole("heading", {
      name: /Solana Subscriptions can take up to 18\.4 quintillion .*\(no practical limit\)/,
    }),
  ).toBeVisible();
  // What was read is said plainly; the slot and origin wait under Technical details.
  await expect(page.locator(".coverage-note")).toContainText("Velon read only this account.");
  await page.locator(".state-meta summary").click();
  await expect(page.getByText("fixture evidence · slot 122 · Partial coverage")).toBeVisible();
  await expect(page.locator(".state-meta summary")).toHaveCSS("color", ON_FOREST);
  await expect(page.locator(".state-meta .eyebrow")).toHaveCSS("color", ON_FOREST_2);
  // The raw evidence sits on a light wash, so it keeps the cards' dark text.
  await expect(page.locator(".state-meta pre")).toHaveCSS("color", "rgb(47, 64, 56)");
  // Availability is the runtime's evaluation; only a conditional grant reads as in force, and
  // the summary never counts one as active.
  await expect(page.locator("#results .availability")).toHaveText("In force");
  const face = page.locator("#results article").first();
  await expect(face.locator(".technical")).toBeHidden();
  await expect(face).not.toContainText("Acts directly", { useInnerText: true });
  await expect(face).not.toContainText("slot", { useInnerText: true });
  await expect(page.locator(".summary")).toContainText("1Permissions found");
  await expect(page.locator(".summary")).not.toContainText("Active");
  await page.screenshot({ path: `test-results/${info.project.name}-scan.png`, fullPage: true });
  await page.locator("#scenario").selectOption("1");
  await expect(
    page.getByRole("heading", { name: /can take up to 25 of this token's smallest units in total/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "What changed", exact: true }).click();
  await expect(page.getByText("This fixture has one observation.", { exact: false })).toBeVisible();
});

test("empty, invalid, failed and conflicting observations suppress stale grants", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Who can act on this account" })).toBeVisible();
  await page.locator("#address").fill("11111111111111111111111111111111");
  await page.locator("#scan").click();
  await expect(page.getByText("Velon found no permissions on this account", { exact: false })).toBeVisible();
  // The empty state carries the coverage caveat, so it must stay readable on the forest page.
  await expect(page.locator("#results > .empty")).toHaveCSS("color", ON_FOREST_2);
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

test("the product page keeps its own lead, apart from the console's review dialog", async ({ page }) => {
  await page.goto("/");
  for (const lead of await page.locator(".lead").all()) await expect(lead).toHaveCSS("margin-bottom", "36px");
});
