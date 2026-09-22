'use strict';

const crypto = require('node:crypto');

/// Room encryption, the Node half. A copy of lib/crypto.js in metacomdev/metacom, which also
/// has web/crypto.js, the same scheme on WebCrypto. Keep the three in step.
///
/// Every device has a P-256 identity keypair. A room has a random 256-bit key; the owner
/// seals it to each device's public key (ephemeral ECDH → HKDF-SHA256 → AES-256-GCM) and
/// the server only ever stores those sealed copies. Message text in an encrypted room is
/// "enc1:<iv>.<ciphertext>" (base64url), AES-256-GCM under the room key with the room name as
/// associated data, so a ciphertext cannot be replayed into another room.
/// P-256 rather than X25519 because every browser's WebCrypto has it.
const CURVE = 'prime256v1';
const INFO = 'metacom room key v1';
const PREFIX = 'enc1:';

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (s) => Buffer.from(String(s), 'base64url');

/// A new identity: raw 65-byte uncompressed public key and the private scalar, both base64url.
const generateKeyPair = () => {
  const ecdh = crypto.createECDH(CURVE);
  ecdh.generateKeys();
  return { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(ecdh.getPrivateKey()) };
};

const publicKeyOf = (privateKey) => {
  const ecdh = crypto.createECDH(CURVE);
  ecdh.setPrivateKey(unb64(privateKey));
  return b64(ecdh.getPublicKey());
};

const isPublicKey = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{86,88}$/.test(s) && unb64(s).length === 65;

const wrapKey = (shared, salt) => crypto.hkdfSync('sha256', shared, salt, INFO, 32);

/// Room key sealed to one public key: { epk, iv, ct } (all base64url).
const seal = (roomKey, recipientPublicKey) => {
  const eph = crypto.createECDH(CURVE);
  eph.generateKeys();
  const shared = eph.computeSecret(unb64(recipientPublicKey));
  const epk = eph.getPublicKey();
  const key = wrapKey(shared, epk);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), iv);
  const ct = Buffer.concat([cipher.update(unb64(roomKey)), cipher.final(), cipher.getAuthTag()]);
  return { epk: b64(epk), iv: b64(iv), ct: b64(ct) };
};

const unseal = (sealed, privateKey) => {
  const me = crypto.createECDH(CURVE);
  me.setPrivateKey(unb64(privateKey));
  const epk = unb64(sealed.epk);
  const shared = me.computeSecret(epk);
  const key = wrapKey(shared, epk);
  const ct = unb64(sealed.ct);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), unb64(sealed.iv));
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
  return b64(plain);
};

const generateRoomKey = () => b64(crypto.randomBytes(32));

const isSealed = (text) => typeof text === 'string' && text.startsWith(PREFIX);

const encryptText = (text, roomKey, room) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', unb64(roomKey), iv);
  cipher.setAAD(Buffer.from(String(room), 'utf8'));
  const ct = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `${PREFIX}${b64(iv)}.${b64(ct)}`;
};

/// Plain text, or null when this is not a ciphertext for that room key.
const decryptText = (text, roomKey, room) => {
  if (!isSealed(text)) return text;
  try {
    const [iv, ct64] = text.slice(PREFIX.length).split('.');
    const ct = unb64(ct64);
    const decipher = crypto.createDecipheriv('aes-256-gcm', unb64(roomKey), unb64(iv));
    decipher.setAAD(Buffer.from(String(room), 'utf8'));
    decipher.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
};

module.exports = { generateKeyPair, publicKeyOf, isPublicKey, seal, unseal, generateRoomKey, isSealed, encryptText, decryptText, PREFIX };
