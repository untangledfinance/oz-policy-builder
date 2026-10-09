# MetaMask (built-in Solana account) as a signing service for psn.ts

Extension: MetaMask 13.50.0 Chrome build from github.com/MetaMask/metamask-extension (sha256 b759caca…0e47c, matches SHA256SUMS of the release), unpacked in `ext/`. It ships solana-wallet-snap 5.0.1.
Wallet: a local test seed imported through the extension UI (`secrets/mm-test.json`, never printed or committed). No account was created on any website.

- `bridge.mjs` holds the browser and answers on 127.0.0.1:8830: `address`, `signMessage {hex}`, `signTransaction {tx, chain}`, `useScope {scope}`, `quit`. It confirms each MetaMask prompt and logs the prompt text to `bridge.log`.
- `page.html` is the dapp page (Wallet Standard client) served on 127.0.0.1:8821.
- `drive.mjs` + `d.sh` are the exploration driver used to import the seed and read the settings pages.
- `stub/real-wallet-check.ts` runs the three real-wallet checks; `stub/nearsig-stub.ts` replaces NEAR for dry runs (`NEARSIG_STUB=...`).
- `run-validator.sh` starts the local validator on 8899 cloned from devnet (programs A and B from the current `.so`).

Run: `Xvfb :91 -screen 0 1280x900x24 -nolisten tcp -ac &`, then `DISPLAY=:91 node bridge.mjs`, then
`PSN_NATIVE=1 PSN_MM_BRIDGE=http://127.0.0.1:8830 flock /home/ubuntu/work/prime-refine/near.lock bun psn.ts` in swig-spike.
After a browser restart MetaMask is locked; the bridge unlocks it from the seed file's password.
