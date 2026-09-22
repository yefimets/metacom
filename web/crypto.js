'use strict';

// Room encryption on WebCrypto: the same scheme as lib/crypto.js (P-256 ECDH → HKDF-SHA256 →
// AES-256-GCM to seal a room key to a device; AES-256-GCM with the room name as associated
// data for message text, "enc1:<iv>.<ct>" in base64url).
const MC = (() => {
  const INFO = new TextEncoder().encode('metacom room key v1');
  const PREFIX = 'enc1:';
  const te = new TextEncoder();
  const td = new TextDecoder();

  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64 = (s) => {
    const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
  };

  // P-256 keys travel as raw uncompressed points (65 bytes) and raw 32-byte scalars; JWK inside.
  const importPublic = (raw) => {
    const bytes = unb64(raw);
    const jwk = { kty: 'EC', crv: 'P-256', x: b64(bytes.slice(1, 33)), y: b64(bytes.slice(33, 65)) };
    return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  };
  const importPrivate = (pair) => {
    const bytes = unb64(pair.publicKey);
    const jwk = { kty: 'EC', crv: 'P-256', x: b64(bytes.slice(1, 33)), y: b64(bytes.slice(33, 65)), d: pair.privateKey };
    return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  };
  const exportPair = async (key) => {
    const pub = await crypto.subtle.exportKey('jwk', key.publicKey);
    const priv = await crypto.subtle.exportKey('jwk', key.privateKey);
    const raw = new Uint8Array(65);
    raw[0] = 4;
    raw.set(unb64(pub.x), 1);
    raw.set(unb64(pub.y), 33);
    return { publicKey: b64(raw), privateKey: priv.d };
  };

  const generateKeyPair = async () => exportPair(await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));

  const wrapKey = async (shared, salt) => {
    const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  };

  const seal = async (roomKey, recipientPublicKey) => {
    const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: await importPublic(recipientPublicKey) }, eph.privateKey, 256);
    const epk = unb64((await exportPair(eph)).publicKey);
    const key = await wrapKey(shared, epk);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, unb64(roomKey));
    return { epk: b64(epk), iv: b64(iv), ct: b64(ct) };
  };

  const unseal = async (sealed, pair) => {
    const me = await importPrivate(pair);
    const epk = unb64(sealed.epk);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: await importPublic(sealed.epk) }, me, 256);
    const key = await wrapKey(shared, epk);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) }, key, unb64(sealed.ct));
    return b64(plain);
  };

  const generateRoomKey = () => b64(crypto.getRandomValues(new Uint8Array(32)));
  const isSealed = (text) => typeof text === 'string' && text.startsWith(PREFIX);
  const roomCipher = (roomKey) => crypto.subtle.importKey('raw', unb64(roomKey), 'AES-GCM', false, ['encrypt', 'decrypt']);

  const encryptText = async (text, roomKey, room) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(String(room)) }, await roomCipher(roomKey), te.encode(String(text)));
    return `${PREFIX}${b64(iv)}.${b64(ct)}`;
  };

  const decryptText = async (text, roomKey, room) => {
    if (!isSealed(text)) return text;
    try {
      const [iv, ct] = text.slice(PREFIX.length).split('.');
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: te.encode(String(room)) }, await roomCipher(roomKey), unb64(ct));
      return td.decode(plain);
    } catch {
      return null;
    }
  };

  return { generateKeyPair, seal, unseal, generateRoomKey, isSealed, encryptText, decryptText };
})();
