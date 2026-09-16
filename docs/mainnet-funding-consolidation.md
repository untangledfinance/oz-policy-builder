# Mainnet deployment funding — 2026-09-16

Tuan explicitly authorized funding the deployer from other controlled wallets after his 70 XLM top-up. Public-key inventory covered 69 Stellar CLI identities and 28 distinct keys in existing project configuration. Signing material stayed in memory or the existing CLI signer.

Destination: GCIVG2AIEWMDA43HX2HRCYVNY7PH7HMPYVN42LQ5XBSHBLHFUWG47NFN.

The deployer balance increased from 88.1490627 to **114.0000000 XLM** through seven confirmed native payments. Total transferred **25.8509373 XLM**; aggregate classic transaction fees **0.0000700 XLM**.

| Source | Transferred XLM | Balance retained XLM | Required reserve XLM |
| --- | ---: | ---: | ---: |
| Mainnet agent | 16.3685817 | 1.2500000 | 1.0000000 |
| UNT issuer | 3.7113964 | 1.2500000 | 1.0000000 |
| Deployment funding | 1.2174769 | 2.2500000 | 2.0000000 |
| Cosign fixture A | 0.6975774 | 1.2500000 | 1.0000000 |
| Cosign fixture B | 0.7324267 | 1.2500000 | 1.0000000 |
| UNT distributor | 0.2499400 | 1.7500000 | 1.5000000 |
| RMS facilitator | 2.8735382 | 2.1052990 | 1.0000000 |

Reserve calculations included sponsorship and native selling liabilities. The script verified single-account signing authority, the PUBLIC network, exact destination, a 26 XLM aggregate transfer limit, and retained balances after confirmation. Other assets and account structure were not changed.

Receipts, full public addresses, hashes and ledgers: audit/evidence/mainnet-funding-consolidation.json. Reproduction script defaults to read-only: scripts/consolidate-mainnet-deployment-funds.ts.

A fresh upload simulation fit a reduced **112 XLM total deployment fee cap** and **1 XLM interpreter-instance cap**. Deployment is a separate operation with its own receipts; the 114 XLM balance above is the balance immediately before deployment.
