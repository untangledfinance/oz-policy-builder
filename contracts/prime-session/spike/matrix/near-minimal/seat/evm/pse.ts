// Seat-voting sessions on EVM: each Safe owner is a PrimeSession contract (ERC-1271), spike harness.
// Run:  ~/.foundry/bin/anvil --fork-url https://sepolia.base.org --port 8567 &
//       flock /home/ubuntu/work/prime-refine/near.lock bun pse.ts        (NEARSIG_STUB=./nearsig-stub.ts for a dry run without NEAR)
// Owners of the Safe: three PrimeSession contracts (MetaMask's own key; Freighter and Phantom through NEAR MPC under prime:evm-session), threshold 2.
import { st, results, gasOf, stats, save, pub, record, note, PK, NG, BASE } from './pse-core.ts';
await import('./pse-setup.ts');
await import('./pse-seats.ts');
await import('./pse-time.ts');
await import('./pse-replay.ts');
await import('./pse-danger.ts');
await import('./pse-roles.ts');
await import('./pse-gas.ts');

note('B. deployed bytecode equals the build (immutables masked)');
for (const [name, addr, a] of [['PrimeSession(MetaMask)', st.pkMM, PK], ['PrimeSession(Freighter)', st.pkFR, PK], ['PrimeSession(Phantom)', st.pkPH, PK],
  ['PrimeSessionNoGov(MetaMask)', st.ngMM, NG], ['PrimeSessionNoGov(Freighter)', st.ngFR, NG], ['PrimeSessionNoGov(Phantom)', st.ngPH, NG], ['production PrimeSession (gas comparison)', st.pkBase, BASE]] as [string, any, any][]) {
  const local = Buffer.from(a.deployedBytecode.object.slice(2), 'hex'), chain = Buffer.from(((await pub.getCode({ address: addr })) as string).slice(2), 'hex');
  const refs = Object.values(a.deployedBytecode.immutableReferences ?? {}).flat() as { start: number; length: number }[];
  for (const r of refs) { local.fill(0, r.start, r.start + r.length); chain.fill(0, r.start, r.start + r.length); }
  record(`B. ${name} at ${addr.slice(0, 10)}…: ${chain.length} bytes, ${refs.length} immutable slots, equal to the build`, true, local.equals(chain), `${chain.length} bytes`);
}
st.gas = gasOf; st.mpc = stats; save();
console.log('gas:', Object.entries(gasOf).map(([k, v]) => `${k} ${v}`).join(', '));
console.log('gas of one Safe vote:', JSON.stringify(st.gasSafeVote, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
console.log(`NEAR MPC signatures: ${stats.calls}, average ${(stats.ms / Math.max(1, stats.calls) / 1000).toFixed(1)}s`);
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.name, r.detail);
process.exit(0);
