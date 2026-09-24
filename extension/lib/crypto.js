// Byte helpers + RC4 for the Xiaomi cloud protocol. Hashes use WebCrypto.

export const utf8 = new TextEncoder();
export const utf8d = new TextDecoder();

export function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64decode(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export async function sha1(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
}

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** RC4 with the first 1024 keystream bytes dropped (what Xiaomi calls "ENCRYPT-RC4"). */
export function rc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 255;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const out = new Uint8Array(data.length);
  let i = 0, j = 0;
  for (let n = -1024; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + S[i]) & 255;
    [S[i], S[j]] = [S[j], S[i]];
    if (n >= 0) out[n] = data[n] ^ S[(S[i] + S[j]) & 255];
  }
  return out;
}
