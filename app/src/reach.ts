// How a visitor's wallet can reach Velon from where they are. Pure, so every case is tested.
export type Device = "android" | "ios" | "desktop";

export function deviceOf(userAgent: string, touchPoints = 0): Device {
  if (/android/i.test(userAgent)) return "android";
  // iPadOS asks for desktop pages, so it reports a Mac with a touch screen.
  if (/iphone|ipad|ipod/i.test(userAgent) || (/macintosh/i.test(userAgent) && touchPoints > 1)) return "ios";
  return "desktop";
}

export interface WalletLink {
  name: string;
  href: string;
}

/// Links that open a page inside a wallet app's own browser, where that wallet can connect.
/// Only wallets that document such a link are listed; the page keeps its #address.
export function openInWallet(page: string): WalletLink[] {
  const url = encodeURIComponent(page);
  const ref = encodeURIComponent(new URL(page).origin);
  return [
    { name: "Phantom", href: `https://phantom.com/ul/browse/${url}?ref=${ref}` },
    { name: "Solflare", href: `https://solflare.com/ul/v1/browse/${url}?ref=${ref}` },
  ];
}

export const INSTALL: WalletLink[] = [
  { name: "Phantom", href: "https://phantom.com" },
  { name: "Solflare", href: "https://solflare.com" },
  { name: "Backpack", href: "https://backpack.app" },
];

/// A wallet's refusal or failure, in words that say what happened and what still holds.
export function connectFailure(message: string): { text: string; error: boolean } | undefined {
  // The phone already shows Velon's own "no wallet app" dialog for this one.
  if (/no installed wallet|wallet not found/i.test(message)) return undefined;
  if (/reject|declin|cancel|denied by user|user closed|timed out/i.test(message))
    return {
      text: "The wallet didn't connect, and nothing changed. Try again when you're ready.",
      error: false,
    };
  if (/local network access|loopback/i.test(message))
    return {
      text: "This browser blocked Velon from reaching the wallet app on this phone. Allow local network access for this site in the browser's site settings, then connect again.",
      error: true,
    };
  return { text: message || "The wallet couldn't connect.", error: true };
}
