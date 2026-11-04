//! Acceptance of the reference keyless liquidation and run rules
//! (F-2026-20241, requirement R2).
//!
//! Loads the reference `predicate_hex` vectors in
//! `tests/fixtures/reference_keyless_predicates.json` (two sets of recorded
//! rule bytes), decodes each with the crate's own `dsl::decode_stored` under the
//! reference limits, then runs both the patched `crate::pins_own` (with the
//! F-2026-20241 grants pin) and a verbatim copy of the pre-patch `pins_own` as a
//! control. The control must accept the self-scoped rules (liquidate, no-reserve
//! branch: set A 22 / set B 14; run: set A 5 / set B 5); the patched code must
//! still accept them, or the fix would break keyless liquidation.
//!
//! The take-over rules (set A 21 / set B 13) are scoped to the take-over adapter
//! but bound to the gated adapter, so scope != executor and `pins_own` is never
//! consulted for them; the follower (set A 28) is likewise scope != executor. We
//! assert those facts.
//!
//! No chain access: this is the crate's own decoder and its own `pins_own`, run
//! against the recorded bytes.

use soroban_sdk::{symbol_short, Bytes, Env, Symbol, Val};
use std::string::{String, ToString};
use std::vec::Vec as StdVec;

use crate::dsl;
use crate::types::Limits;

/// The deploy-time limits the reference rules were recorded under: reads 8,
/// leaves 400, bytes 24,576, elems 32, in 32, depth 5.
const REFERENCE: Limits = Limits {
    max_reads: 8,
    max_leaves: 400,
    max_predicate_bytes: 24_576,
    max_elems: 32,
    max_in_operands: 32,
    max_depth: 5,
};

// ---- a verbatim copy of the pre-F-20241 `pins_own`, as the control ----
//
// Identical to `crate::pins_own` before the grants pin was added. It uses only
// the public `dsl` surface, so the only difference from the patched function is
// the final grants check.
fn old_pins_own(e: &Env, root: &dsl::Node) -> bool {
    use dsl::PathStep::{Index, Key, Len};
    if dsl::pins_call_fn(e, root, &symbol_short!("run")) {
        return true;
    }
    let pinned = |steps: &[dsl::PathStep], ok: &dyn Fn(&Val) -> bool, set: bool| {
        dsl::pins(root, &|l| dsl::is_call_path(e, l, steps), ok, set)
    };
    let any = |_: &Val| true;
    let zero = |v: &Val| dsl::number(e, v) == Some(0);
    let execute = dsl::pins_call_fn(e, root, &symbol_short!("execute"));
    if !(execute && pinned(&[Index(2)], &zero, false)) {
        return false;
    }
    let (target, function) = (symbol_short!("target"), Symbol::new(e, "function_name"));
    let mut m: u32 = 0;
    while [&target, &function].iter().all(|field| {
        let at = [Index(0), Index(m), Key(field.to_val())];
        pinned(&at, &any, true)
    }) {
        m += 1;
    }
    let short = |v: &Val| dsl::number(e, v).is_some_and(|n| n <= i128::from(m));
    pinned(&[Index(0), Len], &short, false)
}

// ---- a minimal reader for the compact single-line JSON fixture ----

fn predicates_json() -> String {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/reference_keyless_predicates.json"
    );
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("no {path}: {e}"))
}

/// The object text for one rule of one section. Each rule object has no nested
/// braces, so the first `}` after its `"id":N,"signers"` marker closes it.
fn rule_obj(json: &str, section: &str, id: u32) -> String {
    let sec = std::format!("\"{section}\":[");
    let start = json.find(&sec).expect("section") + sec.len();
    let region = &json[start..];
    let region = if section == "set-a" {
        &region[..region.find("],\"set-b\"").expect("set A end")]
    } else {
        region
    };
    let idpat = std::format!("\"id\":{id},\"signers\"");
    let p = region.find(&idpat).expect("id");
    let obj_start = region[..p].rfind('{').expect("obj start");
    let obj_end = region[obj_start..].find('}').expect("obj end") + obj_start;
    region[obj_start..=obj_end].to_string()
}

fn field_str(obj: &str, key: &str) -> Option<String> {
    let pat = std::format!("\"{key}\":");
    let i = obj.find(&pat)? + pat.len();
    let rest = &obj[i..];
    if let Some(stripped) = rest.strip_prefix('"') {
        Some(stripped[..stripped.find('"')?].to_string())
    } else {
        None // null or a bare number
    }
}

fn hex_to_bytes(env: &Env, hex: &str) -> Bytes {
    let raw: StdVec<u8> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
        .collect();
    Bytes::from_slice(env, &raw)
}

struct Loaded {
    bytes: Bytes,
    scope_eq_executor: bool,
}

fn load(env: &Env, json: &str, section: &str, id: u32) -> Loaded {
    let obj = rule_obj(json, section, id);
    let hex = field_str(&obj, "predicate_hex").expect("predicate_hex");
    let scope = field_str(&obj, "scope");
    let executor = field_str(&obj, "executor");
    Loaded {
        bytes: hex_to_bytes(env, &hex),
        scope_eq_executor: executor.is_some() && scope == executor,
    }
}

fn decode(env: &Env, bytes: &Bytes) -> dsl::Node {
    dsl::decode_stored(env, bytes, &REFERENCE).expect("decodes under the reference limits")
}

/// The reference self-scoped keyless rules (scope == executor, so `pins_own`
/// applies) are still accepted by the patched `pins_own`. The control (old
/// `pins_own`) accepts them too, so the grants pin did not change what binds
/// here: the reference liquidate rules already pin `call_arg_len(1)` (5, and 3 on
/// the second branch), and `run` pins the function.
#[test]
fn self_scoped_reference_rules_still_bind_under_the_patched_pins_own() {
    let env = Env::default();
    let json = predicates_json();
    let self_scoped = [
        ("set-a", 22u32, "liquidate set A 22"),
        ("set-b", 14u32, "liquidate set B 14"),
        ("set-a", 5u32, "run set A 5"),
        ("set-b", 5u32, "run set B 5"),
    ];
    for (section, id, label) in self_scoped {
        let r = load(&env, &json, section, id);
        assert!(
            r.scope_eq_executor,
            "{label}: expected scope == executor (pins_own applies)"
        );
        let root = decode(&env, &r.bytes);
        assert!(
            old_pins_own(&env, &root),
            "{label}: control (old pins_own) must accept the reference rule"
        );
        assert!(
            crate::pins_own(&env, &root),
            "{label}: patched pins_own must still accept the reference rule"
        );
    }
}

/// The take-over rules and the follower are bound to an adapter other than
/// their scope (scope != executor), so `pins_own` is never consulted for them.
#[test]
fn cross_scoped_reference_rules_do_not_reach_pins_own() {
    let env = Env::default();
    let json = predicates_json();
    for (section, id, label) in [
        ("set-a", 21u32, "take-over set A 21"),
        ("set-b", 13u32, "take-over set B 13"),
        ("set-a", 28u32, "follower set A 28"),
    ] {
        let r = load(&env, &json, section, id);
        assert!(
            !r.scope_eq_executor,
            "{label}: expected scope != executor (pins_own does NOT apply)"
        );
    }
}
