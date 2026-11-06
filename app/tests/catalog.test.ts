import { expect, test } from "bun:test";
import { accept, type Program } from "../scripts/catalog.ts";

const program = (required: boolean): Program => ({
  id: "De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44",
  name: "Solana Subscriptions",
  builds: [{ hash: "a".repeat(64), source: "example@0", buildToolchain: "example" }],
  protocol: "subscriptions",
  schema: { uri: "https://example.com", revision: "0" },
  adapter: "subscriptions.rs",
  adapterVersion: "0.3",
  required,
});

test("a failed capture is reported as failed, not read, and only stops a required program", () => {
  expect(accept(program(false), undefined, "https://rpc.example.com", "0".repeat(40))).toEqual([]);
  expect(() => accept(program(true), undefined, "https://rpc.example.com", "0".repeat(40))).toThrow(
    "Capturing Solana Subscriptions failed.",
  );
});

test("a capture of an unpinned build is listed but not verified", () => {
  const raw = JSON.stringify({ version: `sha256:${"b".repeat(64)}` });
  expect(accept(program(false), raw, "https://rpc.example.com", "0".repeat(40))).toEqual([]);
  expect(() => accept(program(true), raw, "https://rpc.example.com", "0".repeat(40))).toThrow(
    "not a verified build",
  );
});
