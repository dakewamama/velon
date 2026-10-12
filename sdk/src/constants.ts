export const SUBSCRIPTION_PROGRAM_ID = "De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44";

// snchor compatible event tag: Sha256("anchor:event")[..8] little-endian
export const EVENT_IX_TAG = new Uint8Array([
    0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d
]);

// wire format: 8-byte tag + 1-byte discriminator
export const EVENT_DISCRIMINATOR_LEN = 9;

//Event discriminator values
export const EventDiscriminators = {
    SubscriptionCreated: 0,
    SubscriptionCancelled: 1,
    SubscriptionTransfer: 2,
    FixedTransfer: 3,
    RecurringTransfer: 4,
    SubscriptionResumed: 5,
} as const;

