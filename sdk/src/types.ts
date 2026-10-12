export type Address = string;

export interface SubscriptionCreatedEvent {
    type: "SubscriptionCreated";
    plan: Address;
    subscriber: Address;
    mint: Address;
    createdTs: bigint;
}

export interface SubscriptionCancelledEvent {
    type: "SubscriptionCancelled";
    plan: Address;
    subscriber: Address;
    expiresAtTs: bigint;
}

export interface SubscriptionTransferEvent {
    type: "SubscriptionTransfer";
    subscription: Address;
    plan: Address;
    delegator: Address;
    mint: Address;
    amount: bigint;
    periodStartTs: bigint;
    periodEndTs: bigint;
    amountPulledInPeriod: bigint;
    receiver: Address;

}

export interface FixedTransferEvent {
    type: "FixedTransfer";
    delegation: Address;
    delegator: Address;
    delegatee: Address;
    mint: Address;
    amount: bigint;
    remainingAmount: bigint;
    receiver: Address;
}

export interface RecurringTransferEvent {
    type: "RecurringTransfer";
    delegation: Address;
    delegator: Address;
    delegatee: Address;
    mint: Address;
    amount: bigint;
    periodStartTs: bigint;
    periodEndTs: bigint;
    amountPulledInPeriod: bigint;
    receiver: Address;
}

export interface SubscriptionResumedEvent {
    type: "SubscriptionResumed";
    plan: Address;
    subscriber: Address;
    resumedTs: bigint;
}

export type CatalystEvent =
    | SubscriptionCreatedEvent
    | SubscriptionCancelledEvent
    | SubscriptionTransferEvent
    | FixedTransferEvent
    | RecurringTransferEvent
    | SubscriptionResumedEvent;