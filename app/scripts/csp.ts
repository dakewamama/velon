// The hosted console's Content-Security-Policy. Solana Mobile's connection prompts bring their own
// <style> blocks and style attributes; each is allowed by its exact hash, read from the pinned package.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const sha = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

export function phoneWalletBundle(): string {
  const manifest = require.resolve("@solana-mobile/wallet-standard-mobile/package.json");
  return readFileSync(join(dirname(manifest), "lib/esm/index.browser.js"), "utf8");
}

/// The exact text of every style block and style attribute the package can put on the page. Each
/// modal's block is the shared base followed by its own styles; the spinner's stands alone.
export function phoneWalletStyles(bundle: string): { blocks: string[]; attributes: string[] } {
  const css = new Map(
    [...bundle.matchAll(/const (css(?:\$\d+)?) = `([^`]*)`;/g)].map((match) => [match[1]!, match[2]!]),
  );
  const text = (name: string) => {
    const value = css.get(name);
    if (value === undefined) throw new Error(`Solana Mobile's bundle has no ${name}; recheck its styles.`);
    return value;
  };
  const base = /styles\.textContent = (css\$\d+) \+ this\.contentStyles;/.exec(bundle)?.[1];
  const modals = [...bundle.matchAll(/contentStyles = (css(?:\$\d+)?);/g)].map((match) => match[1]!);
  const alone = [...bundle.matchAll(/styles\.textContent = (css(?:\$\d+)?);/g)].map((match) => match[1]!);
  if (!base || !modals.length || !alone.length)
    throw new Error("Solana Mobile's bundle changed shape; its style hashes can't be read.");
  return {
    blocks: [...new Set([...modals.map((name) => text(base) + text(name)), ...alone.map(text)])],
    attributes: [...new Set([...bundle.matchAll(/style="([^"]*)"/g)].map((match) => match[1]!))],
  };
}

export function consoleCsp(bundle = phoneWalletBundle()): string {
  const { blocks, attributes } = phoneWalletStyles(bundle);
  return [
    "default-src 'self'",
    "script-src 'self'",
    `style-src 'self' 'unsafe-hashes' ${[...blocks, ...attributes].map(sha).join(" ")}`,
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    // A phone's wallet app answers on a local socket, and Firefox opens it through a hidden frame.
    "connect-src 'self' ws://localhost:*",
    "frame-src solana-wallet:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
