// Signs a text exactly like Freighter's signMessage (extension/src/helpers/stellar.ts + handlers/signBlob.ts):
//   signPayload = encodeSep53Message(message); signature = Keypair.fromSecret(secret).sign(signPayload)
// Usage: bun freighter-sign.ts <keyfile.json> <textfile>   -> prints base64 signature (what signMessage returns)
import { Keypair, hash } from '@stellar/stellar-sdk';
import { readFileSync } from 'node:fs';
const SIGN_MESSAGE_PREFIX = "Stellar Signed Message:\n";
const encodeSep53Message = (message: string) => {
  const messageBytes = Buffer.from(message, "utf8");
  const prefixBytes = Buffer.from(SIGN_MESSAGE_PREFIX, "utf8");
  const encodedMessage = Buffer.concat([prefixBytes, messageBytes]);
  return hash(encodedMessage);
};
const [keyfile, textfile] = process.argv.slice(2);
const kp = Keypair.fromSecret(JSON.parse(readFileSync(keyfile, 'utf8')).secret);
process.stdout.write(Buffer.from(kp.sign(encodeSep53Message(readFileSync(textfile, 'utf8')))).toString('base64'));
