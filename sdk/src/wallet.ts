import { address, getPublicKeyFromAddress } from "@solana/addresses";
import { bytesEqual } from "@solana/codecs-core";
import { verifySignature } from "@solana/keys";
import { getCompiledTransactionMessageDecoder } from "@solana/transaction-messages";
import { getTransactionDecoder, getTransactionEncoder } from "@solana/transactions";

export async function signReviewedTransaction(
  reviewedBytes: Uint8Array,
  signTransaction: (transaction: Uint8Array) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const reviewed = new Uint8Array(reviewedBytes);
  const decoder = getTransactionDecoder();
  const transaction = decoder.decode(reviewed);
  const [message, end] = getCompiledTransactionMessageDecoder().read(transaction.messageBytes, 0);
  if (message.version !== "legacy") {
    throw new Error("Unsupported reviewed transaction version");
  }
  if (end !== transaction.messageBytes.length) {
    throw new Error("Trailing reviewed message bytes");
  }
  const signerCount = Object.keys(transaction.signatures).length;
  if (signerCount === 0 || signerCount !== message.header.numSignerAccounts) {
    throw new Error("Invalid reviewed transaction signers");
  }
  const encoder = getTransactionEncoder();
  if (!bytesEqual(encoder.encode(transaction), reviewed)) {
    throw new Error("Noncanonical reviewed transaction");
  }

  // Keep the review snapshot separate from buffers retained or modified by the wallet.
  const signedBytes = new Uint8Array(await signTransaction(new Uint8Array(reviewed)));
  const signed = decoder.decode(signedBytes);
  if (!bytesEqual(transaction.messageBytes, signed.messageBytes)) {
    throw new Error("Wallet changed the reviewed transaction message");
  }
  if (!bytesEqual(encoder.encode(signed), signedBytes)) {
    throw new Error("Noncanonical signed transaction");
  }
  for (const [signer, signature] of Object.entries(signed.signatures)) {
    if (!signature) {
      throw new Error(`Missing wallet signature for ${signer}`);
    }
    const publicKey = await getPublicKeyFromAddress(address(signer));
    if (!(await verifySignature(publicKey, signature, signed.messageBytes))) {
      throw new Error(`Invalid wallet signature for ${signer}`);
    }
  }
  return signedBytes;
}
