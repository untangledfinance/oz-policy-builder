# Phantom (its own EVM account) as a signing service for pkn.ts

`bridge.mjs` drives the real Phantom extension from `/home/ubuntu/work/phantom-spike/ext` with a copy of its profile (`profile/`, Account 2 = the EVM account). It answers on 127.0.0.1:8831:
`address`, `personal_sign {message}` (a 0x-hex message is signed as raw bytes, the Safe eth_sign form), `typed {data}` (eth_signTypedData_v4), `chain {chainId}`, `quit`. Prompts are confirmed by the script and logged to `bridge.log`.

Run: `Xvfb :91 ... &`, `DISPLAY=:91 node bridge.mjs`, then in swig-spike:
`PKN_NATIVE=1 PKN_PH_BRIDGE=http://127.0.0.1:8831 flock /home/ubuntu/work/prime-refine/near.lock bun pkn.ts` (anvil fork on 8547). Without `PKN_PH_BRIDGE` a local key stands in.
