/**
 * Content addressing for the fidelity subsystem.
 *
 * Pure TypeScript, no `node:crypto` and no WebCrypto: this package is above the host seam
 * (ARCHITECTURE.md §1) and WebCrypto's digest is async, which would make the sidecar builder
 * async for no reason. SHA-256 here is ~40 lines and runs once per distinct property blob.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const encoder = new TextEncoder();

export function sha256Bytes(data: Uint8Array): Uint8Array {
  const len = data.length;
  const bitLenHi = Math.floor((len / 0x20000000) | 0);
  const bitLenLo = (len << 3) >>> 0;
  const padded = new Uint8Array(((len + 9 + 63) & ~63));
  padded.set(data);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLenHi, false);
  dv.setUint32(padded.length - 4, bitLenLo, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!, y = w[i - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0, false); odv.setUint32(4, h1, false); odv.setUint32(8, h2, false); odv.setUint32(12, h3, false);
  odv.setUint32(16, h4, false); odv.setUint32(20, h5, false); odv.setUint32(24, h6, false); odv.setUint32(28, h7, false);
  return out;
}

const HEX = "0123456789abcdef";

export function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += HEX[b[i]! >> 4]! + HEX[b[i]! & 15]!;
  return s;
}

export function sha256Hex(data: Uint8Array | string): string {
  return toHex(sha256Bytes(typeof data === "string" ? encoder.encode(data) : data));
}

/** Short content-address for sidecar refs. 12 hex = 48 bits; collision risk is negligible
 *  within one document and a collision is benign anyway (identical XML by construction). */
export function shortHash(data: Uint8Array | string, n = 12): string {
  return sha256Hex(data).slice(0, n);
}

/* --------------------------------------------------------------- 64-bit FNV-1a, as hi/lo */

export interface U64 { hi: number; lo: number }

/** FNV-1a over UTF-16 code units. Used for shingle hashing and simhash feature hashing. */
export function fnv1a64(s: string): U64 {
  // offset basis 0xcbf29ce484222325, prime 0x100000001b3
  let hi = 0xcbf29ce4, lo = 0x84222325;
  for (let i = 0; i < s.length; i++) {
    lo = (lo ^ (s.charCodeAt(i) & 0xffff)) >>> 0;
    // multiply by 0x100000001b3 = (1 << 40) + 0x1b3
    const l0 = lo & 0xffff, l1 = lo >>> 16, h0 = hi & 0xffff, h1 = hi >>> 16;
    // 0x1b3 * (hi:lo)
    const p = 0x1b3;
    let r0 = l0 * p;
    let r1 = l1 * p + (r0 >>> 16);
    let r2 = h0 * p + (r1 >>> 16);
    let r3 = h1 * p + (r2 >>> 16);
    let nlo = ((r1 & 0xffff) << 16 | (r0 & 0xffff)) >>> 0;
    let nhi = ((r3 & 0xffff) << 16 | (r2 & 0xffff)) >>> 0;
    // + (value << 40) : contributes only to the high word, shifted by 8
    nhi = (nhi + ((lo << 8) >>> 0)) >>> 0;
    hi = nhi >>> 0;
    lo = nlo >>> 0;
  }
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

export function u64Hex(v: U64): string {
  return v.hi.toString(16).padStart(8, "0") + v.lo.toString(16).padStart(8, "0");
}

export function u64FromHex(s: string): U64 {
  return { hi: parseInt(s.slice(0, 8), 16) >>> 0, lo: parseInt(s.slice(8, 16), 16) >>> 0 };
}

export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

export function hamming64(a: U64, b: U64): number {
  return popcount32((a.hi ^ b.hi) >>> 0) + popcount32((a.lo ^ b.lo) >>> 0);
}
