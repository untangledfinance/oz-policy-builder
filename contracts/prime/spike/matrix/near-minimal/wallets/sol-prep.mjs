// Solana payloads: prime-session grant text, prime-near-signer text (path prime:solana, domain 1), a legacy and a v0 devnet transfer (unsigned, wallet is fee payer).
import { Connection, Keypair, TransactionInstruction, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const H = '/home/ubuntu/work/wallet-matrix/real';
const pub = JSON.parse(readFileSync(`${H}/secrets/pub.json`, 'utf8'));
const owner = new PublicKey(pub.sol["m/44'/501'/0'/0'"]);
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
const pda = Keypair.generate().publicKey, key = Keypair.generate().publicKey, until = Math.floor(Date.now() / 1000) + 3600, dest = Keypair.generate().publicKey;
const grantText = `Prime session\nsigner: ${pda.toBase58()}\nsession key: ${key.toBase58()}\nvalid until (unix time): ${until}\ncluster: devnet`;
const nearText = `Prime NEAR signer\ncontract: signer.prime-spike-muwguc60.testnet\npath: prime:solana\ndomain: 1\npayload: ${createHash('sha256').update('wm-near-payload-solana').digest('hex')}`;
const ix = SystemProgram.transfer({ fromPubkey: owner, toPubkey: dest, lamports: 1000 });
const legacy = new Transaction({ feePayer: owner, recentBlockhash: blockhash }).add(ix);
const v0 = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message());
const relayer = new PublicKey('JDHmpeiTjYbHkaShE29EdNLtuRRYR5zKuJUmBK5jee2G'); // funded devnet account used only as a fee payer in an unsent, unsigned message
const vote = new Transaction({ feePayer: relayer, recentBlockhash: blockhash }).add(new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [{ pubkey: owner, isSigner: true, isWritable: false }], data: Buffer.from('prime seat vote') }));
writeFileSync(`${H}/payloads/solana.json`, JSON.stringify({ relayer: relayer.toBase58(), relayerTx: vote.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), relayerMsg: vote.serializeMessage().toString('base64'), owner: owner.toBase58(), ownerAlt: pub.sol["m/44'/501'/0'"], grantText, nearText, blockhash, lastValidBlockHeight,
  legacyTx: legacy.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), legacyMsg: legacy.serializeMessage().toString('base64'),
  v0Tx: Buffer.from(v0.serialize()).toString('base64'), v0Msg: Buffer.from(v0.message.serialize()).toString('base64') }, null, 1));
console.log('ok', owner.toBase58(), pub.sol);
