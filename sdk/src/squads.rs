//! Squads V4 token spending limits on controlled multisigs.
//! Layouts follow the deployed program's accounts; every claim here is executed in tests/squads.rs.

use crate::{Action, ActionKind, Adapter, Context, Error, Protocol, SourceRequirements};
use arm::*;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::{pubkey, Pubkey};

pub const PROGRAM_ID: Pubkey = pubkey!("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
pub const PROGRAM_VERSION: &str =
    "sha256:dec8d3e0fae58c7c8f2416e5f67c25e673f047afd6dd2bba4a47e0b29a01d34c";
pub const DEPLOYMENT: &str =
    "solana:loader-v3:Fy3YMJCvwbAXUgUM5b91ucUVA3jYzwWLHL3MwBqKsh8n:302582236";

const SPENDING_LIMIT: [u8; 8] = [10, 201, 27, 160, 218, 195, 222, 152];
const MULTISIG: [u8; 8] = [224, 116, 121, 186, 68, 161, 79, 236];
const REMOVE_SPENDING_LIMIT: [u8; 8] = [228, 198, 136, 111, 123, 4, 178, 113];
const DAY: u64 = 24 * 60 * 60;

pub struct SpendingLimitAdapter;

pub struct State {
    pub address: Pubkey,
    pub account: Account,
    /// Observation of the multisig named by the spending limit.
    pub multisig: Account,
}

struct SpendingLimit {
    multisig: Pubkey,
    vault: Pubkey,
    mint: Pubkey,
    amount: u64,
    period: u8,
    remaining: u64,
    last_reset: i64,
    members: Vec<Pubkey>,
    destinations: Vec<Pubkey>,
}

struct Reader<'a>(&'a [u8]);

impl Reader<'_> {
    fn take<const N: usize>(&mut self) -> Result<[u8; N], Error> {
        let (head, tail) = self
            .0
            .split_first_chunk::<N>()
            .ok_or_else(|| Error::InvalidState("truncated account".into()))?;
        self.0 = tail;
        Ok(*head)
    }

    fn key(&mut self) -> Result<Pubkey, Error> {
        self.take().map(Pubkey::new_from_array)
    }

    fn keys(&mut self) -> Result<Vec<Pubkey>, Error> {
        let count = u32::from_le_bytes(self.take()?) as usize;
        if count > self.0.len() / 32 {
            return Err(Error::InvalidState("truncated account".into()));
        }
        (0..count).map(|_| self.key()).collect()
    }
}

fn owned(account: &Account, discriminator: [u8; 8]) -> Result<Reader<'_>, Error> {
    if account.owner != PROGRAM_ID || account.executable {
        return Err(Error::InvalidState("program owner".into()));
    }
    let mut reader = Reader(&account.data);
    if reader.take::<8>()? != discriminator {
        return Err(Error::InvalidState("account discriminator".into()));
    }
    Ok(reader)
}

fn decode(state: &State) -> Result<SpendingLimit, Error> {
    let mut reader = owned(&state.account, SPENDING_LIMIT)?;
    let multisig = reader.key()?;
    let create_key = reader.key()?;
    let [vault_index] = reader.take()?;
    let mint = reader.key()?;
    let amount = u64::from_le_bytes(reader.take()?);
    let [period] = reader.take()?;
    let remaining = u64::from_le_bytes(reader.take()?);
    let last_reset = i64::from_le_bytes(reader.take()?);
    let [bump] = reader.take()?;
    let members = reader.keys()?;
    let destinations = reader.keys()?;
    let seeds: [&[u8]; 4] = [
        b"multisig",
        multisig.as_ref(),
        b"spending_limit",
        create_key.as_ref(),
    ];
    if !reader.0.is_empty()
        || Pubkey::find_program_address(&seeds, &PROGRAM_ID) != (state.address, bump)
        || amount == 0
        || remaining > amount
        || period > 3
        || members.is_empty()
        || members.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(Error::InvalidState("spending limit".into()));
    }
    let vault = Pubkey::find_program_address(
        &[b"multisig", multisig.as_ref(), b"vault", &[vault_index]],
        &PROGRAM_ID,
    )
    .0;
    Ok(SpendingLimit {
        multisig,
        vault,
        mint,
        amount,
        period,
        remaining,
        last_reset,
        members,
        destinations,
    })
}

/// Reads the whole multisig as the program does and binds it to the limit's parent address.
fn config_authority(state: &State, parent: Pubkey) -> Result<Pubkey, Error> {
    let mut reader = owned(&state.multisig, MULTISIG)?;
    let create_key = reader.key()?;
    let authority = reader.key()?;
    // Threshold, time lock, transaction index and stale transaction index.
    reader.take::<22>()?;
    match reader.take()? {
        [0] => {}
        [1] => {
            reader.key()?;
        }
        _ => return Err(Error::InvalidState("multisig rent collector".into())),
    }
    let [bump] = reader.take()?;
    let members = u32::from_le_bytes(reader.take()?) as usize;
    // Reallocation leaves stale bytes after the members; the program ignores them too.
    if members > reader.0.len() / 33
        || Pubkey::find_program_address(
            &[b"multisig", b"multisig", create_key.as_ref()],
            &PROGRAM_ID,
        ) != (parent, bump)
    {
        return Err(Error::InvalidState("multisig".into()));
    }
    // Autonomous multisigs change limits by member vote; a threshold is not one signer.
    if authority == Pubkey::default() {
        return Err(Error::UnsupportedOperation);
    }
    Ok(authority)
}

fn any_of(keys: &[Pubkey]) -> Principal {
    match keys {
        [key] => Principal::Identity(key.to_string()),
        keys => Principal::AnyOf(
            keys.iter()
                .map(|key| Principal::Identity(key.to_string()))
                .collect(),
        ),
    }
}

fn account(key: Pubkey) -> Resource {
    Resource {
        namespace: "solana:account".into(),
        id: key.to_string(),
    }
}

fn remove(state: &State) -> Result<Instruction, Error> {
    let limit = decode(state)?;
    let authority = config_authority(state, limit.multisig)?;
    let mut data = REMOVE_SPENDING_LIMIT.to_vec();
    data.push(0);
    Ok(Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(limit.multisig, false),
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new(state.address, false),
            AccountMeta::new(authority, false),
        ],
        data,
    })
}

impl Adapter for SpendingLimitAdapter {
    type State = State;

    fn protocol(&self) -> Protocol {
        Protocol {
            name: "squads-v4",
            program_id: PROGRAM_ID,
        }
    }

    fn supports(&self, native: &NativeContext) -> bool {
        native.protocol == "squads-v4"
            && native.deployment == DEPLOYMENT
            && native.program_version == PROGRAM_VERSION
            && native.adapter_version == "0.1"
    }

    fn source_requirements(&self, state: &State) -> SourceRequirements {
        let mut accounts = vec![state.address];
        if let Ok(limit) = decode(state) {
            accounts.push(limit.multisig);
        }
        SourceRequirements {
            accounts,
            // The stored remainder is stale once the period has passed; the reader needs the clock.
            clock: true,
        }
    }

    fn compile_state(&self, state: &State, context: &Context) -> Result<Vec<Authorization>, Error> {
        if state.account == Account::default() {
            return Ok(vec![]);
        }
        let limit = decode(state)?;
        let authority = config_authority(state, limit.multisig)?;
        // Native SOL limits move lamports through another path that has no executed fixture here.
        if limit.mint == Pubkey::default() {
            return Err(Error::UnsupportedOperation);
        }
        let amount = ConstraintExpr::Constraint(Constraint::AmountAtMost {
            asset: Resource {
                namespace: "solana:mint".into(),
                id: limit.mint.to_string(),
            },
            amount: limit.amount,
        });
        let spend = Authorization {
            schema_version: SCHEMA_VERSION.into(),
            id: format!("{PROGRAM_ID}:{}:spending-limit:spend", state.address),
            subject: Subject::Resource(account(limit.multisig)),
            principal: any_of(&limit.members),
            resource: account(limit.vault),
            capability: Capability::Spend,
            // An empty destination list places no restriction on the recipient.
            constraints: if limit.destinations.is_empty() {
                amount
            } else {
                ConstraintExpr::All(vec![
                    amount,
                    ConstraintExpr::Constraint(Constraint::Recipient {
                        principal: any_of(&limit.destinations),
                    }),
                ])
            },
            usage: match limit.period {
                0 => UsageSemantics::Cumulative {
                    remaining: Some(limit.remaining),
                },
                period => UsageSemantics::Recurring {
                    period_seconds: [DAY, 7 * DAY, 30 * DAY][period as usize - 1],
                    anchor_unix_seconds: limit.last_reset,
                    observed_period_start: limit.last_reset,
                    remaining: Some(limit.remaining),
                },
            },
            lifecycle: Lifecycle::Active {
                valid_from: None,
                valid_until: None,
            },
            delegability: Delegability::Unknown,
            authority_kind: AuthorityKind::Direct,
            enforcement: Enforcement::Native,
            observability: Observability::Exact,
            evidence: context.evidence.clone(),
            native_context: context.native.clone(),
        };
        let control = Authorization {
            id: format!("{PROGRAM_ID}:{}:spending-limit:revoke", state.address),
            principal: Principal::Identity(authority.to_string()),
            resource: account(state.address),
            capability: Capability::RevokeAuthority,
            constraints: ConstraintExpr::True,
            usage: UsageSemantics::Unlimited,
            authority_kind: AuthorityKind::Administrative,
            ..spend.clone()
        };
        Ok(vec![spend, control])
    }

    fn diff_transaction(
        &self,
        instructions: &[Instruction],
        state: &State,
        context: &Context,
    ) -> Result<Vec<AuthorizationChange>, Error> {
        if instructions != [remove(state)?] {
            return Err(Error::UnsupportedOperation);
        }
        // Removal closes the account, so the controller's authority over it ends with the limit.
        Ok(self
            .compile_state(state, context)?
            .into_iter()
            .map(|authorization| AuthorizationChange::Removed {
                authorization: Box::new(authorization),
            })
            .collect())
    }

    fn actions(
        &self,
        authorization: &Authorization,
        state: &State,
        context: &Context,
    ) -> Result<Vec<Action>, Error> {
        if !self.compile_state(state, context)?.contains(authorization) {
            return Err(Error::InvalidProjection);
        }
        if authorization.capability != Capability::Spend {
            return Err(Error::UnsupportedOperation);
        }
        Ok(vec![Action {
            kind: ActionKind::Revoke,
            authorization_id: authorization.id.clone(),
            instructions: vec![remove(state)?],
        }])
    }
}
