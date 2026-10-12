import { getAddressDecoder } from "@solana/addresses";
import { getWallets } from "@wallet-standard/app";
import type { StandardConnectFeature, StandardEventsFeature } from "@wallet-standard/features";
import type { SolanaSignTransactionFeature } from "@solana/wallet-standard-features";

type RegisteredWallet = ReturnType<ReturnType<typeof getWallets>["get"]>[number];
export type SigningWallet = RegisteredWallet & {
  features: StandardConnectFeature & StandardEventsFeature & SolanaSignTransactionFeature;
};
export const wallets = getWallets();
export function signingWallets(): SigningWallet[] {
  return wallets.get().filter((wallet): wallet is SigningWallet => {
    const features = wallet.features as Partial<SigningWallet["features"]>;
    return (
      typeof features["standard:connect"]?.connect === "function" &&
      typeof features["standard:events"]?.on === "function" &&
      typeof features["solana:signTransaction"]?.signTransaction === "function" &&
      features["solana:signTransaction"].supportedTransactionVersions.includes("legacy")
    );
  });
}

/// A throwaway key held by this page so the console can be tried without an extension.
/// It signs single-signer legacy transactions, which is all the test chain flow uses.
export async function testWallet(): Promise<SigningWallet> {
  const pair = (await crypto.subtle.generateKey("Ed25519", false, ["sign"])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const account = {
    address: getAddressDecoder().decode(publicKey),
    publicKey,
    chains: ["solana:localnet"],
    features: ["solana:signTransaction"],
  };
  const sign = async ({ transaction }: { transaction: Uint8Array }) => {
    const bytes = new Uint8Array(transaction);
    bytes.set(new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, bytes.slice(65))), 1);
    return { signedTransaction: bytes };
  };
  return {
    version: "1.0.0",
    name: "Velon test wallet",
    icon: "data:image/svg+xml,<svg/>",
    chains: ["solana:localnet"],
    accounts: [account],
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy"],
        signTransaction: (...inputs: { transaction: Uint8Array }[]) => Promise.all(inputs.map(sign)),
      },
    },
  } as unknown as SigningWallet;
}
