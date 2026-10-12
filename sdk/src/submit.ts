import type {
  GetBlockHeightApi,
  GetGenesisHashApi,
  IsBlockhashValidApi,
  Rpc,
  SendTransactionApi,
} from "@solana/rpc";
import { getCompiledTransactionMessageDecoder } from "@solana/transaction-messages";
import {
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type TransactionBlockhashLifetime,
} from "@solana/transactions";
import { signReviewedTransaction } from "./wallet";

export async function signAndSubmitReviewedTransaction(
  rpc: Rpc<
    GetGenesisHashApi &
      GetBlockHeightApi &
      IsBlockhashValidApi &
      SendTransactionApi
  >,
  reviewedBytes: Uint8Array,
  signTransaction: (transaction: Uint8Array) => Promise<Uint8Array>,
  config: Readonly<{
    genesisHash: string;
    minContextSlot: bigint;
    lifetime: Readonly<TransactionBlockhashLifetime>;
    abortSignal?: AbortSignal;
  }>,
) {
  const reviewed = new Uint8Array(reviewedBytes);
  const { genesisHash, minContextSlot, abortSignal } = config;
  const { blockhash, lastValidBlockHeight } = config.lifetime;
  const u64Max = (1n << 64n) - 1n;
  if (
    !genesisHash ||
    typeof minContextSlot !== "bigint" ||
    minContextSlot < 0n ||
    minContextSlot > u64Max ||
    typeof lastValidBlockHeight !== "bigint" ||
    lastValidBlockHeight <= 0n ||
    lastValidBlockHeight > u64Max
  ) {
    throw new Error("Invalid reviewed transaction lifetime");
  }
  const decoder = getTransactionDecoder();
  const message = getCompiledTransactionMessageDecoder().decode(
    decoder.decode(reviewed).messageBytes,
  );
  if (message.version !== "legacy" || message.lifetimeToken !== blockhash) {
    throw new Error("Reviewed transaction blockhash mismatch");
  }
  const commitment = "finalized" as const;
  async function checkLifetime() {
    abortSignal?.throwIfAborted();
    const [cluster, height, validity] = await Promise.all([
      rpc.getGenesisHash().send({ abortSignal }),
      rpc.getBlockHeight({ commitment, minContextSlot }).send({ abortSignal }),
      rpc
        .isBlockhashValid(blockhash, { commitment, minContextSlot })
        .send({ abortSignal }),
    ]);
    if (cluster !== genesisHash)
      throw new Error("Submission cluster genesis mismatch");
    if (
      typeof height !== "bigint" ||
      height < 0n ||
      height > u64Max ||
      typeof validity.context.slot !== "bigint" ||
      validity.context.slot < minContextSlot ||
      validity.context.slot > u64Max
    ) {
      throw new Error("Invalid transaction lifetime evidence");
    }
    if (height > lastValidBlockHeight || validity.value !== true) {
      throw new Error("Reviewed transaction expired or blockhash unavailable");
    }
    abortSignal?.throwIfAborted();
  }
  const signed = await signReviewedTransaction(reviewed, async (bytes) => {
    await checkLifetime();
    return signTransaction(bytes);
  });
  await checkLifetime();
  const transaction = decoder.decode(signed);
  const signedTransaction = getBase64EncodedWireTransaction(transaction);
  const signature = getSignatureFromTransaction(transaction);
  try {
    const received = await rpc
      .sendTransaction(signedTransaction, {
        encoding: "base64",
        preflightCommitment: commitment,
        skipPreflight: false,
        minContextSlot,
      })
      .send({ abortSignal });
    if (received !== signature)
      throw new Error("RPC returned a different transaction signature");
    return { status: "submitted" as const, signature, signedTransaction };
  } catch (error) {
    // A failed response cannot prove that submission did not reach the network.
    return { status: "unknown" as const, signature, signedTransaction, error };
  }
}
