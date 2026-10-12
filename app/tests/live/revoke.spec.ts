import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getAddressDecoder } from "@solana/addresses";

const keypair = process.env.LIVE_OWNER_KEYPAIR;
const rpcUrl = process.env.RPC_URL;
test.describe.configure({ mode: "serial" });
test.skip(!keypair || !rpcUrl, "Requires LIVE_OWNER_KEYPAIR and RPC_URL from scripts/local.ts.");

async function delegate(request: APIRequestContext, source: string): Promise<string | undefined> {
  const params = [source, { encoding: "jsonParsed", commitment: "finalized" }];
  const reply = await request.post(rpcUrl!, {
    data: { jsonrpc: "2.0", id: 1, method: "getAccountInfo", params },
  });
  return (await reply.json()).result.value.data.parsed.info.delegate;
}

async function genesis(request: APIRequestContext): Promise<string> {
  const reply = await request.post(rpcUrl!, { data: { jsonrpc: "2.0", id: 1, method: "getGenesisHash" } });
  return (await reply.json()).result;
}

// The wallet holds the real owner key; mode only changes how it answers the signing request.
async function review(page: Page, request: APIRequestContext, mode: "sign" | "reject" | "alter", shots = "") {
  const secret: number[] = JSON.parse(readFileSync(keypair!, "utf8"));
  const owner = getAddressDecoder().decode(Uint8Array.from(secret.slice(32)));
  await page.addInitScript(
    ({ owner, secret, mode }) => {
      const account = {
        address: owner,
        publicKey: new Uint8Array(secret.slice(32)),
        chains: ["solana:localnet"],
        features: ["solana:signTransaction"],
      };
      const pkcs8 = [48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32, ...secret.slice(0, 32)];
      const wallet = {
        version: "1.0.0",
        name: "Local owner key",
        icon: "data:image/svg+xml,<svg/>",
        chains: ["solana:localnet"],
        accounts: [account],
        features: {
          "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
          "standard:events": { version: "1.0.0", on: () => () => {} },
          "solana:signTransaction": {
            version: "1.0.0",
            supportedTransactionVersions: ["legacy"],
            signTransaction: async ({ transaction }: { transaction: Uint8Array }) => {
              if (mode === "reject") throw new Error("User rejected the request");
              const bytes = new Uint8Array(transaction);
              if (mode === "alter") bytes[bytes.length - 1]! ^= 1;
              const key = await crypto.subtle.importKey(
                "pkcs8",
                new Uint8Array(pkcs8),
                { name: "Ed25519" },
                false,
                ["sign"],
              );
              bytes.set(new Uint8Array(await crypto.subtle.sign("Ed25519", key, bytes.slice(65))), 1);
              return [{ signedTransaction: bytes }];
            },
          },
        },
      };
      window.addEventListener("wallet-standard:app-ready", (event) => {
        (event as CustomEvent<{ register: (wallet: unknown) => void }>).detail.register(wallet);
      });
    },
    { owner, secret, mode },
  );
  // Outbound submissions are counted, never answered: the validator still replies.
  const sends: string[] = [];
  page.on("request", (sent) => {
    if (sent.url().startsWith(rpcUrl!) && sent.postDataJSON()?.method === "sendTransaction")
      sends.push(sent.postDataJSON().params[0]);
  });
  await page.goto("/app");
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  // The wallet's accounts are read from the chain before the first one is shown.
  await expect(page.locator("#address")).not.toHaveValue("", { timeout: 30000 });
  const source = await page.locator("#address").inputValue();
  const spender = await delegate(request, source);
  expect(spender).toBeTruthy();
  await expect(page.locator("#results article")).toContainText(spender!);
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  // Observation and simulation are real round trips; allow for a busy machine.
  await expect(page.getByRole("dialog")).toContainText(spender!, { timeout: 30000 });
  await expect(page.getByRole("dialog")).toContainText(source);
  if (mode === "sign")
    await page.screenshot({ path: `test-results/live-${shots}-review.png`, fullPage: true });
  await page.getByRole("button", { name: "Confirm in wallet" }).click();
  return { source, spender: spender!, sends };
}

for (const mode of ["reject", "alter"] as const) {
  test(`wallet ${mode}: nothing is submitted and the delegate keeps its allowance`, async ({
    page,
    request,
  }) => {
    const { source, spender, sends } = await review(page, request, mode);
    await expect(page.getByRole("heading", { name: "Not submitted", exact: true })).toBeVisible();
    await expect(page.locator("#action-result dd")).toHaveCount(0);
    expect(sends).toEqual([]);
    expect(await delegate(request, source)).toBe(spender);
  });
}

test("the product page lists what the chain reports and links into the console", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const first = page.locator("#live-rows a").first();
  await expect(first).toBeVisible({ timeout: 30000 });
  const source = new URL((await first.getAttribute("href"))!, "http://x").hash.slice(1);
  const spender = await delegate(request, source);
  expect(spender).toBeTruthy();
  await first.click();
  await expect(page).toHaveURL(/\/app#/);
  await expect(page.locator("#results article")).toContainText(spender!, { timeout: 30000 });
});

test("owner revokes a finalized SPL delegate and the chain agrees", async ({ page, request }, info) => {
  const { source, sends } = await review(page, request, "sign", info.project.name);
  await expect(page.getByRole("heading", { name: "Revoked", exact: true })).toBeVisible({ timeout: 150000 });
  await expect(page.locator("#results article")).toHaveCount(0);
  await page.screenshot({ path: `test-results/live-${info.project.name}-verified.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const [signature, slot, verification] = (await page.locator("#action-result dd").allTextContents()) as [
    string,
    string,
    string,
  ];
  const params = [signature, { commitment: "finalized", encoding: "json" }];
  const reply = await request.post(rpcUrl!, {
    data: { jsonrpc: "2.0", id: 1, method: "getTransaction", params },
  });
  const executed = (await reply.json()).result;
  expect(executed.meta.err).toBeNull();
  expect(sends).toHaveLength(1);
  expect(String(executed.slot)).toBe(slot);
  expect(await delegate(request, source)).toBeUndefined();
  // Kept under ignored .data: Playwright clears test-results on every run.
  const receipt = { signature, finalizedSlot: slot, verification, source, cluster: await genesis(request) };
  mkdirSync(".data/receipts", { recursive: true });
  writeFileSync(`.data/receipts/live-receipt-${slot}.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  expect((await request.get(`/api/verifications/revoke/${verification}`)).status()).toBe(200);
});

test("the test bench approves a real permission that the feed then reports", async ({ page, request }) => {
  await page.goto("/app");
  await page.getByRole("button", { name: "Browse accounts" }).click();
  const bench = page.getByRole("button", { name: "Add a demo permission" });
  await expect(bench).toBeVisible({ timeout: 30000 });
  const before = await page.locator(".feed-row").count();
  await bench.click();
  await expect(page.locator("#notice")).toContainText("on chain", { timeout: 30000 });
  const allowance = /Approving (\d+) base units/.exec(await page.locator("#notice").innerText())![1]!;
  await expect(page.locator(".feed-row")).toHaveCount(before + 1, { timeout: 90000 });
  await expect(page.locator("#feed")).toContainText(`can spend ${allowance}`);
  // The page only reports it; the chain is the authority.
  const row = page
    .locator(".feed-row")
    .filter({ hasText: `can spend ${allowance}` })
    .first();
  await row.click();
  await expect(page.locator("#results article")).toContainText(`${allowance} base units`, { timeout: 30000 });
  expect(await delegate(request, await page.locator("#address").inputValue())).toBeTruthy();
});

test("a visitor with no wallet gets a permission, revokes it and keeps a replayable receipt", async ({
  page,
  request,
}) => {
  const sends: string[] = [];
  page.on("request", (sent) => {
    if (sent.url().startsWith(rpcUrl!) && sent.postDataJSON()?.method === "sendTransaction")
      sends.push(sent.postDataJSON().params[0]);
  });
  await page.goto("/app");
  await page.getByRole("button", { name: "Use a test wallet" }).click();
  await expect(page.locator("#results")).toContainText("No classic SPL token delegates found", {
    timeout: 30000,
  });
  await page.getByRole("button", { name: "Get a test permission" }).click();
  await expect(page.locator("#try-status")).toContainText("Your permission is live", { timeout: 120000 });
  // The wallet granted it by signing; the chain, not the page, is asked whether it exists.
  const source = await page.locator("#address").inputValue();
  const spender = await delegate(request, source);
  expect(spender).toBeTruthy();
  await expect(page.locator("#results article")).toContainText(spender!, { timeout: 30000 });
  // A second permission lives on its own token account beside the first.
  await page.getByRole("button", { name: "Get a test permission" }).click();
  await expect(page.locator("#results article")).toHaveCount(2, { timeout: 120000 });
  const first = page.locator("#results article").first();
  const revoked = await first.locator("dd").nth(2).innerText();
  await first.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(revoked, { timeout: 30000 });
  await page.getByRole("button", { name: "Confirm in wallet" }).click();
  await expect(page.getByRole("heading", { name: "Revoked", exact: true })).toBeVisible({ timeout: 150000 });
  await expect(page.locator("#results article")).toHaveCount(1);
  await expect(page.locator("#results")).not.toContainText(revoked);
  expect(await delegate(request, revoked)).toBeUndefined();
  expect(sends).toHaveLength(3);
  await page.getByRole("button", { name: "Receipts", exact: true }).click();
  await page.getByRole("button", { name: "Replay proof" }).first().click();
  await expect(page.locator("#receipts")).toContainText("Replayed without the chain", { timeout: 30000 });
  // Coming back from Receipts shows the wallet again, with the remaining permission still revocable.
  await page.getByRole("button", { name: "Permissions", exact: true }).click();
  await expect(page.locator("#results article")).toHaveCount(1, { timeout: 30000 });
  await expect(page.locator("#results")).toContainText("Who can act on your wallet");
  await expect(page.getByRole("button", { name: "Revoke", exact: true })).toBeVisible();
});
