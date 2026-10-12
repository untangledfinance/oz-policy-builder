use crate::Chain;

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
    tail: &str,
) -> String {
    let scope = format!(
        "Until it ends, this key approves and votes for you on this Prime Account, and acts alone in rules that list your seat. Every change to the account still needs one wallet signature{}.",
        if chain == Chain::StellarTestnet { " through the sessions rule" } else { "" }
    );
    format!(
        "Prime: start a session\nChain: {}\nPrime Account: {account}\nYour seat: {seat}\nSession key: {key}\nStarts: {}\nEnds: {}\n{scope}\n{tail}",
        chain.label(),
        when(start),
        when(end)
    )
}

pub fn end(chain: Chain, account: &str, seat: &str, key: &str, tail: &str) -> String {
    format!("Prime: end a session\nChain: {}\nPrime Account: {account}\nYour seat: {seat}\nSession key: {key}\nAfter this, the key can never act again.\n{tail}", chain.label())
}
