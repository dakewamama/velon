import { expect, test, type Page } from "@playwright/test";
import { DEVNET_GENESIS } from "../../src/control.ts";

const WALLET = "pau23UpU2BFwF4JZrLxAnf4ZqgnD3xLnz6ESu7vPsao";
const PIXEL =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

// A public console with no wallet installed: the only way to connect is the one the device offers.
async function publicConsole(page: Page) {
  await page.route("**/api/control", (route) =>
    route.fulfill({
      json: { cluster: DEVNET_GENESIS, rpcUrl: "http://127.0.0.1:3390/wallet-test-rpc", network: "devnet" },
    }),
  );
  await page.route("**/api/scenarios", (route) =>
    route.fulfill({
      json: [{ name: "Devnet browser test", scope: "", live: true, snapshots: [], examples: [] }],
    }),
  );
  await page.goto("/app");
  await page.evaluate((wallet) => history.replaceState(null, "", `#${wallet}`), WALLET);
}

test.describe("on Android", () => {
  test.use({ userAgent: PIXEL, isMobile: true, hasTouch: true, viewport: { width: 412, height: 915 } });

  test("Connect reaches for a wallet app and, when none answers, says how to get one", async ({ page }) => {
    await publicConsole(page);
    const connect = page.locator("#connect-wallet");
    await connect.click();
    await expect(connect).toHaveText("Connecting…");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "No wallet app found on this phone" })).toBeVisible({
      timeout: 15000,
    });
    // The page opens inside the wallet app with the wallet being checked still in its address.
    await expect(dialog.getByRole("link", { name: "Open in Phantom" })).toHaveAttribute(
      "href",
      new RegExp(
        `^https://phantom\\.com/ul/browse/http%3A%2F%2F127\\.0\\.0\\.1%3A3390%2Fapp%23${WALLET}\\?ref=`,
      ),
    );
    await expect(connect).toHaveText("Connect wallet");
    await expect(page.locator("#notice")).toBeEmpty();
  });
});

test.describe("on iPhone", () => {
  test.use({ userAgent: IPHONE, isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });

  test("Connect offers to open the page inside a wallet app", async ({ page }) => {
    await publicConsole(page);
    await page.locator("#connect-wallet").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Connect from your wallet app" })).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Open in Solflare" })).toHaveAttribute(
      "href",
      new RegExp(`^https://solflare\\.com/ul/v1/browse/.+%23${WALLET}\\?ref=`),
    );
    await expect(dialog.getByRole("link", { name: "Open in Phantom" })).not.toHaveAttribute(
      "target",
      "_blank",
    );
  });
});
