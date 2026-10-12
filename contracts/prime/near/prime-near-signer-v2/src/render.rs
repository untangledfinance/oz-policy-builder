use crate::hash::{self, addr, b58, hexv, is_pda};
use crate::{Chain, Ix, Op, SafeVote, Scope, SolanaVote};
use near_sdk::{bs58, env, require};

const SQUADS: &str = "SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG";

/// UTC date and time with the unix value in brackets.
pub fn when(t: u64) -> String {
    let z = (t / 86400) as i64 + 719468;
    let (era, doe) = (z.div_euclid(146097), z.rem_euclid(146097));
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (day, month) = (
        doy - (153 * mp + 2) / 5 + 1,
        if mp < 10 { mp + 3 } else { mp - 9 },
    );
    let year = yoe + era * 400 + (month <= 2) as i64;
    let s = t % 86400;
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02} UTC ({t})",
        s / 3600,
        s / 60 % 60,
        s % 60
    )
}

pub fn grant(
    chain: Chain,
    [account, seat, key]: [&str; 3],
    start: u64,
    end: u64,
    scope: Scope,
    me: &str,
) -> String {
    let scope = match scope {
        Scope::RulesOnly => "Until it ends, this key acts for you in rules that list your seat on this Prime Account.".to_string(),
        Scope::Votes => format!(
            "Until it ends, this key approves and votes for you on this Prime Account, and acts alone in rules that list your seat. Every change to the account still needs one wallet signature{}.",
            if chain == Chain::StellarTestnet { " through the sessions rule" } else { "" }
        ),
    };
    format!(
        "Prime: start a session\nChain: {}\nPrime Account: {account}\nYour seat: {seat}\nSession key: {key}\nStarts: {}\nEnds: {}\n{scope}\nSigner: {me}",
        chain.label(),
        when(start),
        when(end)
    )
}

pub fn end(chain: Chain, account: &str, seat: &str, key: &str, me: &str) -> String {
    format!("Prime: end a session\nChain: {}\nPrime Account: {account}\nYour seat: {seat}\nSession key: {key}\nAfter this, the key can never act again.\nSigner: {me}", chain.label())
}

pub fn safe(v: &SafeVote, me: &str) -> (String, [u8; 32]) {
    let (
        c,
        SafeVote {
            safe,
            seat,
            to,
            data,
            nonce,
            ..
        },
    ) = (Chain::BaseSepolia, v);
    let value = v
        .value
        .parse::<u128>()
        .ok()
        .filter(|n| n.to_string() == v.value);
    require!(value.is_some(), "value");
    let (delegate, bytes) = (v.operation == Op::DelegateCall, hexv(data));
    let hash = hash::safe(
        addr(c, false, safe),
        addr(c, false, to),
        value.unwrap_or_default(),
        &bytes,
        delegate,
        *nonce,
    );
    addr(c, false, seat);
    let text = format!(
        "Prime: approve a Safe transaction\nChain: {}\nPrime Account: {safe}\nYour seat: {seat}\nTo: {to}\nValue: {} wei\nData: {data}\nOperation: {}\nSafe nonce: {nonce}\nGas and refund fields: all zero\nSigner: {me}",
        c.label(),
        v.value,
        if delegate { "delegatecall" } else { "call" }
    );
    (text, hash)
}

struct Rd<'a>(&'a [u8]);

impl<'a> Rd<'a> {
    fn take(&mut self, n: usize) -> &'a [u8] {
        require!(self.0.len() >= n, "instruction");
        let (a, b) = self.0.split_at(n);
        self.0 = b;
        a
    }
    fn num(&mut self, n: usize) -> u64 {
        let mut b = [0; 8];
        b[..n].copy_from_slice(self.take(n));
        u64::from_le_bytes(b)
    }
    fn key(&mut self) -> String {
        bs58::encode(self.take(32)).into_string()
    }
    fn signer(&mut self) -> String {
        let (k, m) = (self.key(), self.num(1));
        require!((1..8).contains(&m), "instruction");
        let names = ["initiate", "vote", "execute"];
        format!(
            "{k} with {}",
            (0..3)
                .filter(|i| m >> i & 1 == 1)
                .map(|i| names[i])
                .collect::<Vec<_>>()
                .join(", ")
        )
    }
}

fn settings(args: &[u8]) -> Vec<String> {
    let mut r = Rd(args);
    let n = r.num(4);
    require!(n > 0, "instruction");
    let mut out = vec![];
    for i in 1..=n {
        let line = match r.num(1) {
            0 => format!("add signer {}", r.signer()),
            1 => format!("remove signer {}", r.key()),
            2 => format!("change threshold to {}", r.num(2)),
            3 => format!("set time lock to {} seconds", r.num(4)),
            9 => format!("remove policy {}", r.key()),
            _ => env::panic_str("instruction"),
        };
        out.push(format!("Change {i}: {line}"));
    }
    require!(r.0 == [0], "instruction");
    out
}

fn flags(signer: bool, writable: bool) -> &'static str {
    match (signer, writable) {
        (true, true) => "signer writable",
        (true, false) => "signer",
        (false, true) => "writable",
        _ => "readonly",
    }
}

fn vault(args: &[u8]) -> Vec<String> {
    let mut r = Rd(args);
    require!(r.num(1) == 0, "instruction");
    let (index, ephemeral, len) = (r.num(1), r.num(1), r.num(4) as usize);
    let mut m = Rd(r.take(len));
    require!(r.num(1) == 0 && r.0.is_empty(), "instruction");
    let (signers, writable_signers, writable_others, count) =
        (m.num(1), m.num(1), m.num(1), m.num(1));
    require!(
        writable_signers <= signers && signers + writable_others <= count,
        "instruction"
    );
    let keys: Vec<String> = (0..count).map(|_| m.key()).collect();
    let key = |i: u64| {
        keys.get(i as usize)
            .cloned()
            .unwrap_or_else(|| env::panic_str("instruction"))
    };
    let mut out = vec![
        format!("Vault index: {index}, ephemeral signers: {ephemeral}"),
        "Message accounts:".to_string(),
    ];
    for (i, k) in (0..count).zip(&keys) {
        let signer = i < signers;
        out.push(format!(
            "  {}: {k} {}",
            i + 1,
            flags(
                signer,
                if signer {
                    i < writable_signers
                } else {
                    i - signers < writable_others
                }
            )
        ));
    }
    for n in 1..=m.num(1) {
        let (program, accounts) = (m.num(1), m.num(1) as usize);
        let accounts: Vec<u64> = m.take(accounts).iter().map(|&i| i as u64).collect();
        let data = m.num(2) as usize;
        out.push(format!("Instruction {n}: program {}", key(program)));
        out.extend(
            accounts
                .iter()
                .enumerate()
                .map(|(k, &i)| format!("  Account {}: {}", k + 1, key(i))),
        );
        out.push(format!("  Data: 0x{}", hex::encode(m.take(data))));
    }
    require!(m.num(1) == 0 && m.0.is_empty(), "instruction");
    out
}

/// Squads instructions: snake-case name, positions of the signer, proposal and transaction accounts (0 = none), and 1 when the consensus must be the settings.
const IXS: [(&str, [usize; 4]); 8] = [
    ("create_proposal", [2, 1, 0, 0]),
    ("activate_proposal", [1, 2, 0, 1]),
    ("approve_proposal", [1, 2, 0, 0]),
    ("reject_proposal", [1, 2, 0, 0]),
    ("execute_transaction", [3, 1, 2, 0]),
    ("execute_settings_transaction", [1, 2, 3, 1]),
    ("create_settings_transaction", [2, 0, 1, 1]),
    ("create_transaction", [2, 0, 1, 0]),
];

/// The text for a Squads instruction on the closed list; refuses everything else, including spending-limit use and synchronous execution.
pub fn solana(v: &SolanaVote, me: &str) -> (String, [u8; 32]) {
    let program = b58(&v.instruction.program);
    require!(program == b58(SQUADS), "program");
    let Ix { accounts, data, .. } = &v.instruction;
    let data = hexv(data);
    let keys: Vec<[u8; 32]> = accounts.iter().map(|a| b58(&a.key)).collect();
    require!(data.len() >= 8, "instruction");
    let name = |n: &str| env::sha256(format!("global:{n}").as_bytes())[..8] == data[..8];
    let Some(&(snake, [signer, proposal, tx, settings_only])) = IXS.iter().find(|r| name(r.0))
    else {
        env::panic_str("instruction")
    };
    let (consensus, index) = (b58(&v.consensus), v.index);
    require!(keys.len() > signer.max(proposal).max(tx), "accounts");
    require!(
        keys[0] == consensus && (settings_only == 0 || consensus == b58(&v.settings)),
        "accounts"
    );
    require!(
        keys[signer] == b58(&v.seat) && accounts[signer].signer,
        "accounts"
    );
    require!(
        proposal == 0 || is_pda(&keys[proposal], &program, &consensus, index, true),
        "accounts"
    );
    require!(
        tx == 0 || is_pda(&keys[tx], &program, &consensus, index, false),
        "accounts"
    );
    let args = &data[8..];
    let mut lines = vec![format!(
        "Action: {} {index} of {}",
        snake.replace('_', " "),
        v.consensus
    )];
    if proposal != 0 {
        lines.push(format!("Proposal: {}", accounts[proposal].key));
    }
    if tx != 0 {
        lines.push(format!("Transaction: {}", accounts[tx].key));
    }
    match snake {
        "create_proposal" => {
            require!(
                args.len() == 9 && args[8] < 2 && args[..8] == index.to_le_bytes(),
                "instruction"
            );
            lines.push(format!(
                "Draft: {}",
                if args[8] == 1 { "yes" } else { "no" }
            ));
        }
        "approve_proposal" | "reject_proposal" => require!(args == [0], "instruction"),
        "create_settings_transaction" => lines.extend(settings(args)),
        "create_transaction" => lines.extend(vault(args)),
        _ => require!(args.is_empty(), "instruction"),
    }
    lines.push("Squads accounts:".to_string());
    lines.extend(
        accounts
            .iter()
            .enumerate()
            .map(|(i, a)| format!("  {}: {} {}", i + 1, a.key, flags(a.signer, a.writable))),
    );
    let text = format!(
        "Prime: approve a Squads action\nCluster: devnet\nPrime Account: {}\nYour seat: {}\n{}\nValid until: {}\nSigner: {me}",
        v.settings,
        v.seat,
        lines.join("\n"),
        when(v.valid_until)
    );
    let metas: Vec<_> = keys
        .iter()
        .zip(accounts)
        .map(|(k, a)| (*k, a.signer, a.writable))
        .collect();
    (
        text,
        hash::vote(b58(&v.seat), v.valid_until, program, &metas, &data),
    )
}
