use crate::constants::{EVENT_IX_TAG, EVENT_PREFIX_LEN};
use crate::events::{
    CatalystEvent, FixedTransfer, PlanUpdated, RecurringTransfer, SubscriptionCancelled,
    SubscriptionCreated, SubscriptionResumed, SubscriptionTransfer,
};

const ADDRESS_LEN: usize = 32;

fn read_address(buf: &[u8], offset: usize) -> String {
    bs58::encode(&buf[offset..offset + ADDRESS_LEN]).into_string()
}

fn read_u64(buf: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(buf[offset..offset + 8].try_into().unwrap())
}

fn read_i64(buf: &[u8], offset: usize) -> i64 {
    i64::from_le_bytes(buf[offset..offset + 8].try_into().unwrap())
}

/// Each event's payload length as the pinned builds emit it, and the shorter layout from before
/// subscriptions@2d7b45b added the receiver token account, the puller and the payer.
fn lengths(discriminator: u8) -> Option<(usize, Option<usize>)> {
    match discriminator {
        0 => Some((32 * 4 + 8, Some(32 * 3 + 8))), // SubscriptionCreated
        1 | 5 => Some((32 * 2 + 8, None)),         // SubscriptionCancelled / Resumed
        2 => Some((32 * 7 + 8 * 4, Some(32 * 5 + 8 * 4))), // SubscriptionTransfer
        3 => Some((32 * 6 + 8 * 2, Some(32 * 5 + 8 * 2))), // FixedTransfer
        4 => Some((32 * 6 + 8 * 4, Some(32 * 5 + 8 * 4))), // RecurringTransfer
        6 => Some((32 * 6 + 1 + 8, None)),         // PlanUpdated
        _ => None,
    }
}

/// Decodes one self-CPI event. A payload of any other length is not decoded; its raw bytes are
/// still kept by the caller.
pub fn decode_event(raw: &[u8]) -> Option<CatalystEvent> {
    if raw.len() < EVENT_PREFIX_LEN || raw[..8] != EVENT_IX_TAG {
        return None;
    }
    let discriminator = raw[8];
    let p = &raw[EVENT_PREFIX_LEN..];
    let (current, earlier) = lengths(discriminator)?;
    let full = match p.len() {
        len if len == current => true,
        len if Some(len) == earlier => false,
        _ => return None,
    };
    let newer = |offset: usize| full.then(|| read_address(p, offset));

    match discriminator {
        0 => Some(CatalystEvent::SubscriptionCreated(SubscriptionCreated {
            plan: read_address(p, 0),
            subscriber: read_address(p, 32),
            mint: read_address(p, 64),
            created_ts: read_i64(p, 96),
            payer: newer(104),
        })),
        1 => Some(CatalystEvent::SubscriptionCancelled(
            SubscriptionCancelled {
                plan: read_address(p, 0),
                subscriber: read_address(p, 32),
                expires_at_ts: read_i64(p, 64),
            },
        )),
        2 => Some(CatalystEvent::SubscriptionTransfer(SubscriptionTransfer {
            subscription: read_address(p, 0),
            plan: read_address(p, 32),
            delegator: read_address(p, 64),
            mint: read_address(p, 96),
            amount: read_u64(p, 128),
            period_start_ts: read_i64(p, 136),
            period_end_ts: read_i64(p, 144),
            amount_pulled_in_period: read_u64(p, 152),
            receiver: read_address(p, 160),
            receiver_token_account: newer(192),
            puller: newer(224),
        })),
        3 => Some(CatalystEvent::FixedTransfer(FixedTransfer {
            delegation: read_address(p, 0),
            delegator: read_address(p, 32),
            delegatee: read_address(p, 64),
            mint: read_address(p, 96),
            amount: read_u64(p, 128),
            remaining_amount: read_u64(p, 136),
            receiver: read_address(p, 144),
            receiver_token_account: newer(176),
        })),
        4 => Some(CatalystEvent::RecurringTransfer(RecurringTransfer {
            delegation: read_address(p, 0),
            delegator: read_address(p, 32),
            delegatee: read_address(p, 64),
            mint: read_address(p, 96),
            amount: read_u64(p, 128),
            period_start_ts: read_i64(p, 136),
            period_end_ts: read_i64(p, 144),
            amount_pulled_in_period: read_u64(p, 152),
            receiver: read_address(p, 160),
            receiver_token_account: newer(192),
        })),
        5 => Some(CatalystEvent::SubscriptionResumed(SubscriptionResumed {
            plan: read_address(p, 0),
            subscriber: read_address(p, 32),
            resumed_ts: read_i64(p, 64),
        })),
        6 => Some(CatalystEvent::PlanUpdated(PlanUpdated {
            plan: read_address(p, 0),
            owner: read_address(p, 32),
            status: p[64],
            end_ts: read_i64(p, 65),
            pullers: (0..4)
                .map(|slot| 73 + slot * ADDRESS_LEN)
                .filter(|&offset| p[offset..offset + ADDRESS_LEN] != [0; ADDRESS_LEN])
                .map(|offset| read_address(p, offset))
                .collect(),
        })),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::EVENT_IX_TAG;

    fn make_raw(discriminator: u8, payload: &[u8]) -> Vec<u8> {
        let mut raw = Vec::new();
        raw.extend_from_slice(&EVENT_IX_TAG);
        raw.push(discriminator);
        raw.extend_from_slice(payload);
        raw
    }

    fn address_bytes(val: u8) -> [u8; 32] {
        [val; 32]
    }

    #[test]
    fn decodes_subscription_created() {
        let mut payload = Vec::new();
        payload.extend_from_slice(&address_bytes(1)); // plan
        payload.extend_from_slice(&address_bytes(2)); // subscriber
        payload.extend_from_slice(&address_bytes(3)); // mint
        payload.extend_from_slice(&42i64.to_le_bytes()); // created_ts

        let raw = make_raw(0, &payload);
        let event = decode_event(&raw).unwrap();

        match event {
            CatalystEvent::SubscriptionCreated(e) => {
                assert_eq!(e.created_ts, 42);
            }
            _ => panic!("wrong event type"),
        }
    }

    #[test]
    fn returns_none_for_wrong_tag() {
        let raw = vec![0u8; 20];
        assert!(decode_event(&raw).is_none());
    }

    #[test]
    fn returns_none_for_unknown_discriminator() {
        let mut raw = EVENT_IX_TAG.to_vec();
        raw.push(99);
        raw.extend_from_slice(&[0u8; 32]);
        assert!(decode_event(&raw).is_none());
    }

    #[test]
    fn returns_none_for_short_payload() {
        assert!(decode_event(&[0u8; 4]).is_none());
    }

    #[test]
    fn accepts_only_the_two_known_lengths_for_every_discriminator() {
        let raw = |disc: u8, len: usize| {
            let mut raw = EVENT_IX_TAG.to_vec();
            raw.push(disc);
            raw.extend_from_slice(&vec![0u8; len]);
            raw
        };
        for disc in 0u8..=6 {
            let (current, earlier) = lengths(disc).unwrap();
            assert!(
                decode_event(&raw(disc, current)).is_some(),
                "disc {disc} current"
            );
            assert!(
                decode_event(&raw(disc, current - 1)).is_none(),
                "disc {disc} short"
            );
            assert!(
                decode_event(&raw(disc, current + 1)).is_none(),
                "disc {disc} long"
            );
            if let Some(earlier) = earlier {
                assert!(
                    decode_event(&raw(disc, earlier)).is_some(),
                    "disc {disc} earlier"
                );
            }
        }
    }

    // The pinned builds' SubscriptionTransferEvent, written field by field as write_inner does.
    fn subscription_transfer(newer: bool) -> Vec<u8> {
        let mut payload = Vec::new();
        for byte in 1..=4 {
            payload.extend_from_slice(&address_bytes(byte));
        }
        payload.extend_from_slice(&u64::MAX.to_le_bytes());
        payload.extend_from_slice(&10i64.to_le_bytes());
        payload.extend_from_slice(&20i64.to_le_bytes());
        payload.extend_from_slice(&7u64.to_le_bytes());
        payload.extend_from_slice(&address_bytes(5));
        if newer {
            payload.extend_from_slice(&address_bytes(6));
            payload.extend_from_slice(&address_bytes(7));
        }
        make_raw(2, &payload)
    }

    #[test]
    fn a_subscription_pull_names_its_receiver_account_and_puller() {
        let Some(CatalystEvent::SubscriptionTransfer(e)) =
            decode_event(&subscription_transfer(true))
        else {
            panic!("wrong event type");
        };
        assert_eq!(e.amount, u64::MAX);
        assert_eq!(e.receiver, bs58::encode([5; 32]).into_string());
        assert_eq!(
            e.receiver_token_account,
            Some(bs58::encode([6; 32]).into_string())
        );
        assert_eq!(e.puller, Some(bs58::encode([7; 32]).into_string()));
        // An event from before the fields existed decodes with them absent, never guessed.
        let Some(CatalystEvent::SubscriptionTransfer(e)) =
            decode_event(&subscription_transfer(false))
        else {
            panic!("wrong event type");
        };
        assert_eq!((e.receiver_token_account, e.puller), (None, None));
    }

    #[test]
    fn a_plan_update_lists_only_the_pullers_in_use() {
        let mut payload = Vec::new();
        payload.extend_from_slice(&address_bytes(1));
        payload.extend_from_slice(&address_bytes(2));
        payload.push(1);
        payload.extend_from_slice(&99i64.to_le_bytes());
        for byte in [3, 0, 4, 0] {
            payload.extend_from_slice(&address_bytes(byte));
        }
        let Some(CatalystEvent::PlanUpdated(e)) = decode_event(&make_raw(6, &payload)) else {
            panic!("wrong event type");
        };
        assert_eq!((e.status, e.end_ts), (1, 99));
        assert_eq!(e.owner, bs58::encode([2; 32]).into_string());
        assert_eq!(
            e.pullers,
            [3, 4].map(|byte| bs58::encode([byte; 32]).into_string())
        );
    }
}
