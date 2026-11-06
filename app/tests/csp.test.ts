import { expect, test } from "bun:test";
import { consoleCsp, phoneWalletBundle, phoneWalletStyles } from "../scripts/csp.ts";

test("the console allows exactly the phone wallet's own styles, by hash", () => {
  const { blocks, attributes } = phoneWalletStyles(phoneWalletBundle());
  // Five prompts on one shared base, plus the spinner; an upgrade that changes this fails here.
  expect(blocks).toHaveLength(6);
  expect(attributes).toEqual(["position: absolute; width: 100%; height: 100%;", "mask-type:alpha"]);
  const csp = consoleCsp();
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).toContain("script-src 'self';");
  expect(csp.match(/'sha256-[A-Za-z0-9+/]{43}='/g)).toHaveLength(8);
  expect(csp).toContain("connect-src 'self' ws://localhost:*");
});

test("a bundle that changed shape stops the export instead of shipping a policy that blocks it", () => {
  expect(() => phoneWalletStyles("const css = `a`;")).toThrow("changed shape");
});
