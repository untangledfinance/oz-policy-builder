// Writes apps/evm-web/src/core/prime-session-artifact.ts from the forge output of oz-policy-builder.
import { readFileSync, writeFileSync } from 'node:fs';
import { keccak256 } from 'viem';
const dir = '/home/ubuntu/git/github.com/untangledfinance/oz-policy-builder/contracts/prime/evm/prime-session';
const j = JSON.parse(readFileSync(`${dir}/out/PrimeSession.sol/PrimeSession.json`, 'utf8'));
const code = j.bytecode.object as string;
const hash = keccak256(code as `0x${string}`);
const solc = j.metadata.compiler.version as string;
const out = `// PrimeSession creation code, built from oz-policy-builder \`contracts/prime/evm/prime-session/src/PrimeSession.sol\`.
//   source commit  05a5107 (last change to the file; present unchanged in feat/solana a7a9db1 and 9863b30)
//   solc           ${solc}, optimizer on, 200 runs, evm prague, via_ir off, bytecode hash ipfs
//   build          \`forge build\` in that folder (forge 1.8.4); rebuilt twice with \`--force\`, byte-identical
//   keccak256      ${hash} (${(code.length - 2) / 2} bytes of creation code)
// The constructor takes (owner, roles). A Prime Account's owners each get one instance, deployed by the CREATE2
// deployer from the app's own transaction, so the address is known before anything is sent.
import {
  type Address,
  concat,
  encodeAbiParameters,
  encodePacked,
  getCreate2Address,
  type Hex,
  keccak256,
} from 'viem';

export const PRIME_SESSION_BYTECODE: Hex =
  '${code}';

export const PRIME_SESSION_BYTECODE_HASH: Hex =
  '${hash}';

/** The deterministic CREATE2 deployer on every chain the app runs on (Base Sepolia has it at this address). */
export const CREATE2_DEPLOYER: Address = '0x4e59b44847b379578588920cA78FbF26c0B4956C';

/** \`keccak256("prime-session" || safe || owner)\`: one instance per owner per Prime Account. */
export function primeSessionSalt(safe: Address, owner: Address): Hex {
  return keccak256(encodePacked(['string', 'address', 'address'], ['prime-session', safe, owner]));
}

export function primeSessionInitCode(owner: Address, roles: Address): Hex {
  return concat([
    PRIME_SESSION_BYTECODE,
    encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [owner, roles]),
  ]);
}

/** Where \`owner\`'s PrimeSession for \`safe\` lands, before it is deployed. */
export function predictPrimeSessionAddress(safe: Address, owner: Address, roles: Address): Address {
  return getCreate2Address({
    from: CREATE2_DEPLOYER,
    salt: primeSessionSalt(safe, owner),
    bytecodeHash: keccak256(primeSessionInitCode(owner, roles)),
  });
}
`;
writeFileSync('/home/ubuntu/work/octopos-wt/sess-proofs/apps/evm-web/src/core/prime-session-artifact.ts', out);
console.log(hash, (code.length - 2) / 2, solc);
