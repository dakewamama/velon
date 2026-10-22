import { avatar } from "./icons.ts";
import solLogo from "./assets/tokens/sol.png";
import usdcLogo from "./assets/tokens/usdc.png";
import usdtLogo from "./assets/tokens/usdt.svg";

// Official marks from the Solana token list, bundled so the console makes no third-party requests.
const image = (src: string) => () => {
  const element = document.createElement("img");
  element.src = src;
  element.alt = "";
  element.className = "token-logo";
  return element;
};
const usdc = image(usdcLogo);
const usdt = image(usdtLogo);
const sol = image(solLogo);

export type Token = { symbol: string; name: string; decimals: number; logo: () => Element };

// Mint addresses and decimals are fixed on chain; only these well-known mints get a name.
export const TOKENS: Record<string, Token> = {
  So11111111111111111111111111111111111111112: { symbol: "SOL", name: "Wrapped SOL", decimals: 9, logo: sol },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", name: "USD Coin", decimals: 6, logo: usdc },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: {
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    logo: usdt,
  },
  // Circle's devnet USDC.
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": {
    symbol: "USDC",
    name: "USD Coin (devnet)",
    decimals: 6,
    logo: usdc,
  },
};

export function tokenLogo(mint: string): Element {
  const known = TOKENS[mint];
  if (known) return known.logo();
  const mark = avatar(mint);
  mark.classList.add("token-logo");
  return mark;
}

// Programs whose accounts commonly hold delegate authority. Unlisted owners stay unnamed.
export const PROGRAMS: Record<string, string> = {
  "11111111111111111111111111111111": "System Program",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Account",
  SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf: "Squads V4",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter Aggregator v6",
  De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44: "Solana Subscriptions",
};

export type Delegate = { title: string; detail: string };

/// What the chain says a delegate key is. Display only; the RPC's answer is not evidence.
export async function describeDelegate(rpcUrl: string, key: string): Promise<Delegate> {
  if (PROGRAMS[key]) return { title: PROGRAMS[key]!, detail: "Program" };
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [key, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "finalized" }],
    }),
    signal: AbortSignal.timeout(10000),
  });
  const value = (
    (await response.json()) as { result?: { value?: { owner: string; executable: boolean } | null } }
  ).result?.value;
  if (value === undefined) throw new Error("RPC unavailable");
  if (value === null)
    return {
      title: "Program-derived address",
      detail: "No account at this address; usually a program's signer",
    };
  if (value.executable) return { title: "Program", detail: PROGRAMS[value.owner] ?? "Executable account" };
  if (value.owner === "11111111111111111111111111111111")
    return { title: "Wallet", detail: "A regular key that can sign on its own" };
  const program = PROGRAMS[value.owner];
  return program
    ? { title: program, detail: "An account controlled by this program" }
    : { title: "Program account", detail: `Owned by ${value.owner.slice(0, 4)}…${value.owner.slice(-4)}` };
}
