/** Generate an Ed25519 key pair for access tokens and print .env lines (base64 PEM, single line). */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
console.log(`JWT_PRIVATE_KEY=${Buffer.from(priv).toString('base64')}`);
console.log(`JWT_PUBLIC_KEY=${Buffer.from(pub).toString('base64')}`);
console.log(`DEV_MASTER_KEY=${randomBytes(32).toString('base64')}`);
console.log(`BLIND_INDEX_KEY=${randomBytes(32).toString('base64')}`);
