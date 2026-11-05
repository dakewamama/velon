#[derive(Debug, Clone)]
pub enum CatalystEvent {
    SubscriptionCreated(SubscriptionCreated),
    SubscriptionCancelled(SubscriptionCancelled),
    SubscriptionTransfer(SubscriptionTransfer),
    FixedTransfer(FixedTransfer),
    RecurringTransfer(RecurringTransfer),
    SubscriptionResumed(SubscriptionResumed),
    PlanUpdated(PlanUpdated),
}

#[derive(Debug, Clone)]
pub struct SubscriptionCreated {
    pub plan: String,
    pub subscriber: String,
    pub mint: String,
    pub created_ts: i64,
    /// Who paid the rent; absent from events emitted before subscriptions@2d7b45b.
    pub payer: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SubscriptionCancelled {
    pub plan: String,
    pub subscriber: String,
    pub expires_at_ts: i64,
}

#[derive(Debug, Clone)]
pub struct SubscriptionTransfer {
    pub subscription: String,
    pub plan: String,
    pub delegator: String,
    pub mint: String,
    pub amount: u64,
    pub period_start_ts: i64,
    pub period_end_ts: i64,
    pub amount_pulled_in_period: u64,
    pub receiver: String,
    /// Absent, like `puller`, from events emitted before subscriptions@2d7b45b.
    pub receiver_token_account: Option<String>,
    /// The plan puller that signed this pull.
    pub puller: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FixedTransfer {
    pub delegation: String,
    pub delegator: String,
    pub delegatee: String,
    pub mint: String,
    pub amount: u64,
    pub remaining_amount: u64,
    pub receiver: String,
    pub receiver_token_account: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RecurringTransfer {
    pub delegation: String,
    pub delegator: String,
    pub delegatee: String,
    pub mint: String,
    pub amount: u64,
    pub period_start_ts: i64,
    pub period_end_ts: i64,
    pub amount_pulled_in_period: u64,
    pub receiver: String,
    pub receiver_token_account: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SubscriptionResumed {
    pub plan: String,
    pub subscriber: String,
    pub resumed_ts: i64,
}

#[derive(Debug, Clone)]
pub struct PlanUpdated {
    pub plan: String,
    pub owner: String,
    pub status: u8,
    pub end_ts: i64,
    /// The plan's puller whitelist; the program marks unused slots with the zero address.
    pub pullers: Vec<String>,
}
