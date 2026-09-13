// set_secrets.mjs — Set GitHub Actions secrets via REST API using libsodium-style sealed-box.
// Uses tweetnacl (X25519 + XSalsa20-Poly1305) to replicate crypto_box_seal.
// Usage: node set_secrets.mjs <token> <owner> <repo> <secretsJsonFile>
import fs from 'fs';
import https from 'https';
import nacl from 'C:/Users/zhijian/.workbuddy/binaries/node/workspace/node_modules/tweetnacl';

function req(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const options = {
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'xueqiu-deploy'
      }
    };
    if (data) { options.headers['Content-Type'] = 'application/json'; options.headers['Content-Length'] = Buffer.byteLength(data); }
    const r = https.request(options, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const b64dec = s => Uint8Array.from(Buffer.from(s, 'base64'));
const b64enc = u => Buffer.from(u).toString('base64');

async function setSecret(token, owner, repo, name, value) {
  const pkRes = await req('GET', `https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`, token);
  if (pkRes.status !== 200) throw new Error(`get public key failed: ${pkRes.status} ${pkRes.body}`);
  const pk = JSON.parse(pkRes.body);
  const recipientPub = b64dec(pk.key);           // 32-byte X25519 public key
  const eph = nacl.box.keyPair();                // ephemeral X25519 keypair
  const nonce = new Uint8Array(24);              // crypto_box_seal uses zero nonce
  const msg = new TextEncoder().encode(value);
  const cipher = nacl.box(msg, nonce, recipientPub, eph.secretKey);
  const sealed = new Uint8Array(32 + cipher.length);
  sealed.set(eph.publicKey, 0);                  // prepend ephemeral public key
  sealed.set(cipher, 32);
  const encrypted_value = b64enc(sealed);
  const putRes = await req('PUT', `https://api.github.com/repos/${owner}/${repo}/actions/secrets/${name}`, token, { encrypted_value, key_id: pk.key_id });
  if (putRes.status !== 201 && putRes.status !== 204) throw new Error(`set ${name} failed: ${putRes.status} ${putRes.body}`);
  console.log(`  ✓ secret set: ${name}`);
}

(async () => {
  const [, , token, owner, repo, secretsFile] = process.argv;
  if (!token || !owner || !repo || !secretsFile) {
    console.error('usage: node set_secrets.mjs <token> <owner> <repo> <secretsJsonFile>');
    process.exit(2);
  }
  const secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
  for (const [name, value] of Object.entries(secrets)) {
    await setSecret(token, owner, repo, name, String(value));
  }
  console.log('All secrets set successfully.');
})().catch(e => { console.error('SECRET ERROR:', e.message); process.exit(1); });
