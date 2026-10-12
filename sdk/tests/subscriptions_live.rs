use mollusk_svm::{program, Mollusk};
use mollusk_svm_programs_token::token;
use serde_json::Value;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;
use subscriptions::SUBSCRIPTIONS_ID;

fn bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
        .collect()
}

fn accounts(value: &Value) -> Vec<(Pubkey, Account)> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|value| {
            (
                value["address"].as_str().unwrap().parse().unwrap(),
                Account {
                    owner: value["owner"].as_str().unwrap().parse().unwrap(),
                    lamports: value["lamports"].as_u64().unwrap(),
                    executable: value["executable"].as_bool().unwrap_or(false),
                    data: bytes(value["data"].as_str().unwrap()),
                    ..Account::default()
                },
            )
        })
        .collect()
}

#[test]
fn observed_devnet_program_reproduces_every_native_fixture_transition() {
    let elf = include_bytes!("fixtures/subscriptions-devnet-program.so");
    assert_eq!(
        format!("{:x}", Sha256::digest(elf)),
        "2675ad1d2b5068d47fc5d169156cf4859a9c21c0406ce63e3828e3b7320fddbf"
    );
    let mut vm = Mollusk::default();
    vm.add_program_with_loader_and_elf(&SUBSCRIPTIONS_ID, &program::loader_keys::LOADER_V2, elf);
    token::add_program(&mut vm);
    let mut count = 0;
    for raw in [
        include_str!("fixtures/subscriptions-fixed.json"),
        include_str!("fixtures/subscriptions-recurring.json"),
        include_str!("fixtures/subscriptions-lifecycle.json"),
    ] {
        let trace: Value = serde_json::from_str(raw).unwrap();
        assert_eq!(trace["source"], "56de552a26a0f0af437c0ce5191b3309741cc596");
        for step in trace["transitions"].as_array().unwrap() {
            let clock = step.get("clock").unwrap_or(&trace["clock"]);
            vm.sysvars.clock.slot = clock["slot"].as_u64().unwrap();
            vm.sysvars.clock.unix_timestamp = clock["unix_timestamp"].as_i64().unwrap();
            vm.sysvars.clock.epoch = clock["epoch"].as_u64().unwrap_or(0);
            vm.sysvars.clock.epoch_start_timestamp =
                clock["epoch_start_timestamp"].as_i64().unwrap_or(0);
            vm.sysvars.clock.leader_schedule_epoch =
                clock["leader_schedule_epoch"].as_u64().unwrap_or(0);
            let mut input = accounts(&step["before"]);
            input.extend([
                program::keyed_account_for_system_program(),
                token::keyed_account(),
                (
                    SUBSCRIPTIONS_ID,
                    program::create_program_account_loader_v2(elf),
                ),
            ]);
            let native = &step["instruction"];
            let instruction = Instruction {
                program_id: native["program"].as_str().unwrap().parse().unwrap(),
                data: bytes(native["data"].as_str().unwrap()),
                accounts: native["accounts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|meta| AccountMeta {
                        pubkey: meta["address"].as_str().unwrap().parse().unwrap(),
                        is_signer: meta["signer"].as_bool().unwrap(),
                        is_writable: meta["writable"].as_bool().unwrap(),
                    })
                    .collect(),
            };
            let result = vm.process_instruction(&instruction, &input);
            assert_eq!(format!("{:?}", result.raw_result), step["outcome"]);
            assert_eq!(
                result
                    .resulting_accounts
                    .into_iter()
                    .filter(|(_, account)| !account.executable)
                    .collect::<Vec<_>>(),
                accounts(&step["after"]),
                "{}:{}",
                trace["program_sha256"],
                step["position"]
            );
            count += 1;
        }
    }
    assert_eq!(count, 59);
}
