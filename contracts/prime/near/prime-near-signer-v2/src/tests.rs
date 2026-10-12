use super::*;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, NearToken};
use std::panic::{catch_unwind, AssertUnwindSafe};

const VECTORS: &str = include_str!("../../vectors/requests.json");
const ME: &str = "seats.prime-spike-muwguc60.testnet";

fn vectors() -> Value {
    serde_json::from_str(VECTORS).unwrap()
}

fn at(now: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(ME.parse().unwrap())
        .block_timestamp(now * 1_000_000_000)
        .attached_deposit(NearToken::from_yoctonear(1))
        .build());
}

fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_else(|| panic!("vector field {k}"))
}

fn call(c: &Value) -> Result<Promise, String> {
    at(c["now"]
        .as_u64()
        .unwrap_or(vectors()["now"].as_u64().unwrap()));
    let scheme: Scheme = serde_json::from_value(c["scheme"].clone()).map_err(|e| e.to_string())?;
    let request: Request =
        serde_json::from_value(c["request"].clone()).map_err(|e| e.to_string())?;
    let (wallet, signature) = (
        str_of(c, "wallet").to_string(),
        str_of(c, "signature").to_string(),
    );
    catch_unwind(AssertUnwindSafe(|| {
        Signer.sign(wallet, scheme, request, signature)
    }))
    .map_err(|p| {
        let m = p
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default();
        m.split("panic_msg: \"")
            .nth(1)
            .and_then(|r| r.split('"').next())
            .map_or(m.clone(), str::to_string)
    })
}

#[test]
fn text_path_domain_and_hash_match_the_vectors() {
    let v = vectors();
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 11);
    for c in cases {
        at(c["now"].as_u64().unwrap());
        let (scheme, request): (Scheme, Request) = (
            serde_json::from_value(c["scheme"].clone()).unwrap(),
            serde_json::from_value(c["request"].clone()).unwrap(),
        );
        let p = plan(
            str_of(c, "wallet"),
            scheme,
            &request,
            c["now"].as_u64().unwrap(),
            ME,
        );
        let id = str_of(c, "id");
        assert_eq!(p.text, str_of(c, "text"), "{id}: text");
        assert_eq!(p.path, str_of(c, "path"), "{id}: path");
        assert_eq!(
            p.domain as u64,
            c["domain"].as_u64().unwrap(),
            "{id}: domain"
        );
        assert_eq!(
            hex::encode(p.payload),
            str_of(c, "payload"),
            "{id}: payload"
        );
        if let Some(other) = c.get("not_path") {
            assert_ne!(
                p.path,
                other.as_str().unwrap(),
                "{id}: another scheme must derive another path"
            );
        }
        if let Some(other) = c.get("not_payload") {
            assert_ne!(
                hex::encode(p.payload),
                other.as_str().unwrap(),
                "{id}: refund fields must change the hash"
            );
        }
    }
}

#[test]
fn every_shape_and_scheme_is_covered_by_three_or_more_cases() {
    let v = vectors();
    let count = |k: &str, want: &str| {
        v["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c[k] == want)
            .count()
    };
    for shape in ["Grant", "End"] {
        assert!(count("shape", shape) >= 3, "{shape}");
    }
    for scheme in ["Sep53", "Raw", "Eip191"] {
        assert!(count("scheme", scheme) >= 3, "{scheme}");
    }
}

#[test]
fn signed_vectors_reach_the_mpc_with_the_derived_path_and_hash() {
    for c in vectors()["cases"].as_array().unwrap() {
        let id = str_of(c, "id");
        let _ = call(c).unwrap_or_else(|e| panic!("{id}: {e}"));
        let receipts = get_created_receipts();
        let last = receipts.last().unwrap();
        assert_eq!(last.receiver_id.as_str(), "v1.signer-prod.testnet", "{id}");
        let MockAction::FunctionCallWeight {
            method_name,
            args,
            attached_deposit,
            ..
        } = &last.actions[0]
        else {
            panic!("{id}: not a function call")
        };
        assert_eq!(method_name, b"sign");
        assert_eq!(*attached_deposit, NearToken::from_yoctonear(1));
        let alg = if c["domain"] == 0 { "Ecdsa" } else { "Eddsa" };
        let want = serde_json::json!({ "request": { "path": c["path"], "payload_v2": { alg: c["payload"] }, "domain_id": c["domain"] } });
        assert_eq!(serde_json::from_slice::<Value>(args).unwrap(), want, "{id}");
    }
}

#[test]
fn every_refusal_is_refused_for_its_reason() {
    let v = vectors();
    let refusals = v["refusals"].as_array().unwrap();
    assert!(refusals.len() >= 42);
    for c in refusals {
        let (id, want) = (str_of(c, "id"), str_of(c, "error"));
        match call(c) {
            Ok(_) => panic!("{id}: was accepted"),
            Err(e) if want == "chain" || want == "variant" => {
                assert!(e.contains("unknown variant"), "{id}: {e}")
            }
            Err(e) if want == "field" => assert!(e.contains("unknown field"), "{id}: {e}"),
            Err(e) => assert_eq!(e, want, "{id}"),
        }
    }
}
