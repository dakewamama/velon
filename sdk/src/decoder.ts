import { EVENT_IX_TAG, EventDiscriminators } from "./constants";
import type { CatalystEvent } from "./types";
import bs58 from "bs58";

const ADDRESS_LEN = 32;
const TAG_LEN = 8;
const DISC_LEN = 1;
const PREFIX_LEN = TAG_LEN + DISC_LEN;

function readAddress(buf: Uint8Array, offset: number): string {
    return bs58.encode(buf.slice(offset, offset + ADDRESS_LEN));
}

function readI64(buf: Uint8Array, offset: number): bigint {
    const view = new DataView(buf.buffer, buf.byteOffset + offset, 8);
    return view.getBigInt64(0, true);
}

function readU64(buf: Uint8Array, offset: number): bigint {
    const view = new DataView(buf.buffer, buf.byteOffset + offset, 8);
    return view.getBigUint64(0, true);
}

function matchesTag(buf: Uint8Array): boolean {
    for (let i = 0; i < TAG_LEN; i++) {
        if (buf[i] !== EVENT_IX_TAG[i]) return false;
    }
    return true;
}

export function decodeEvent(data: Uint8Array): CatalystEvent | null {
    if (data.length < PREFIX_LEN) return null;
    if (!matchesTag(data)) return null;

    const discriminator = data[TAG_LEN];
    const p = data.slice(PREFIX_LEN);

    switch (discriminator) {
        case EventDiscriminators.SubscriptionCreated:
            return { type: "SubscriptionCreated", plan: readAddress(p, 0), subscriber: readAddress(p, 32), mint: readAddress(p, 64), createdTs: readI64(p, 96) };
        case EventDiscriminators.SubscriptionCancelled:
            return { type: "SubscriptionCancelled", plan: readAddress(p, 0), subscriber: readAddress(p, 32), expiresAtTs: readI64(p, 64) };
        case EventDiscriminators.SubscriptionTransfer:
            return { type: "SubscriptionTransfer", subscription: readAddress(p, 0), plan: readAddress(p, 32), delegator: readAddress(p, 64), mint: readAddress(p, 96), amount: readU64(p, 128), periodStartTs: readI64(p, 136), periodEndTs: readI64(p, 144), amountPulledInPeriod: readU64(p, 152), receiver: readAddress(p, 160) };
        case EventDiscriminators.FixedTransfer:
            return { type: "FixedTransfer", delegation: readAddress(p, 0), delegator: readAddress(p, 32), delegatee: readAddress(p, 64), mint: readAddress(p, 96), amount: readU64(p, 128), remainingAmount: readU64(p, 136), receiver: readAddress(p, 144) };
        case EventDiscriminators.RecurringTransfer:
            return { type: "RecurringTransfer", delegation: readAddress(p, 0), delegator: readAddress(p, 32), delegatee: readAddress(p, 64), mint: readAddress(p, 96), amount: readU64(p, 128), periodStartTs: readI64(p, 136), periodEndTs: readI64(p, 144), amountPulledInPeriod: readU64(p, 152), receiver: readAddress(p, 160) };
        case EventDiscriminators.SubscriptionResumed:
            return { type: "SubscriptionResumed", plan: readAddress(p, 0), subscriber: readAddress(p, 32), resumedTs: readI64(p, 64) };
        default:
            return null;
    }
}
