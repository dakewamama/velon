import { expect, test } from "bun:test";
import { connectFailure, deviceOf, openInWallet } from "../src/reach.ts";

const PIXEL =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

test("the device decides how a wallet can reach the page", () => {
  expect(deviceOf(PIXEL)).toBe("android");
  expect(deviceOf(IPHONE)).toBe("ios");
  // An iPad asking for the desktop page is still a tablet with no extensions.
  expect(deviceOf(IPAD_AS_MAC, 5)).toBe("ios");
  expect(deviceOf(IPAD_AS_MAC, 0)).toBe("desktop");
});

test("open-in-wallet links carry the page and its checked wallet, fully encoded", () => {
  const page = "https://console.velonsecure.xyz/#pau23UpU2BFwF4JZrLxAnf4ZqgnD3xLnz6ESu7vPsao";
  const [phantom, solflare] = openInWallet(page);
  expect(phantom!.href).toBe(
    "https://phantom.com/ul/browse/https%3A%2F%2Fconsole.velonsecure.xyz%2F%23pau23UpU2BFwF4JZrLxAnf4ZqgnD3xLnz6ESu7vPsao?ref=https%3A%2F%2Fconsole.velonsecure.xyz",
  );
  expect(solflare!.href).toStartWith(
    "https://solflare.com/ul/v1/browse/https%3A%2F%2Fconsole.velonsecure.xyz%2F%23pau23",
  );
  expect(openInWallet(page)).toHaveLength(2);
});

test("a wallet's refusal reads calmly; a missing wallet app is left to its own dialog", () => {
  expect(connectFailure("User rejected the request.")).toEqual({
    text: "The wallet didn't connect, and nothing changed. Try again when you're ready.",
    error: false,
  });
  expect(connectFailure("Wallet connection timed out")?.error).toBe(false);
  expect(
    connectFailure("Found no installed wallet that supports the mobile wallet protocol."),
  ).toBeUndefined();
  expect(connectFailure("Local Network Access permission denied")?.text).toContain("site settings");
  expect(connectFailure("Something else")).toEqual({ text: "Something else", error: true });
});
