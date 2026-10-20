// Minimal CBOR (RFC 8949) encoder/decoder — just what SMP/mcumgr needs.
// Encodes: non-negative/negative integers, strings, Uint8Array, arrays,
// plain objects, booleans, null. Decodes those plus floats and tags.

const te = new TextEncoder();
const td = new TextDecoder();

function head(major, n, out) {
  const m = major << 5;
  if (n < 24) out.push(Uint8Array.of(m | n));
  else if (n < 0x100) out.push(Uint8Array.of(m | 24, n));
  else if (n < 0x10000) out.push(Uint8Array.of(m | 25, n >> 8, n & 0xff));
  else if (n < 0x100000000) {
    out.push(Uint8Array.of(m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff));
  } else {
    const b = new Uint8Array(9);
    b[0] = m | 27;
    new DataView(b.buffer).setBigUint64(1, BigInt(n));
    out.push(b);
  }
}

function write(v, out) {
  if (v === null || v === undefined) out.push(Uint8Array.of(0xf6));
  else if (v === true) out.push(Uint8Array.of(0xf5));
  else if (v === false) out.push(Uint8Array.of(0xf4));
  else if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error('CBOR: floats are not supported for encoding');
    if (v >= 0) head(0, v, out);
    else head(1, -1 - v, out);
  } else if (typeof v === 'string') {
    const b = te.encode(v);
    head(3, b.length, out);
    out.push(b);
  } else if (v instanceof Uint8Array) {
    head(2, v.length, out);
    out.push(v);
  } else if (Array.isArray(v)) {
    head(4, v.length, out);
    for (const x of v) write(x, out);
  } else if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined);
    head(5, keys.length, out);
    for (const k of keys) {
      write(k, out);
      write(v[k], out);
    }
  } else {
    throw new Error('CBOR: unsupported type ' + typeof v);
  }
}

export function encode(value) {
  const parts = [];
  write(value, parts);
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function decode(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;

  const BREAK = Symbol('break');

  function arg(info) {
    if (info < 24) return info;
    if (info === 24) return buf[p++];
    if (info === 25) { const v = dv.getUint16(p); p += 2; return v; }
    if (info === 26) { const v = dv.getUint32(p); p += 4; return v; }
    if (info === 27) { const v = Number(dv.getBigUint64(p)); p += 8; return v; }
    if (info === 31) return -1; // indefinite
    throw new Error('CBOR: bad additional info ' + info);
  }

  function half(h) {
    const e = (h >> 10) & 0x1f;
    const f = h & 0x3ff;
    const v = e === 0 ? f * 2 ** -24 : e === 31 ? (f ? NaN : Infinity) : (f + 1024) * 2 ** (e - 25);
    return h & 0x8000 ? -v : v;
  }

  function read() {
    const ib = buf[p++];
    if (ib === undefined) throw new Error('CBOR: unexpected end of data');
    if (ib === 0xff) return BREAK;
    const major = ib >> 5;
    const info = ib & 0x1f;

    switch (major) {
      case 0: return arg(info);
      case 1: return -1 - arg(info);
      case 2:
      case 3: {
        const n = arg(info);
        if (n < 0) throw new Error('CBOR: indefinite strings are not supported');
        const b = buf.slice(p, p + n);
        p += n;
        return major === 2 ? b : td.decode(b);
      }
      case 4: {
        const n = arg(info);
        const a = [];
        if (n < 0) {
          for (let v = read(); v !== BREAK; v = read()) a.push(v);
        } else {
          for (let i = 0; i < n; i++) a.push(read());
        }
        return a;
      }
      case 5: {
        const n = arg(info);
        const o = {};
        if (n < 0) {
          for (let k = read(); k !== BREAK; k = read()) o[k] = read();
        } else {
          for (let i = 0; i < n; i++) {
            const k = read();
            o[k] = read();
          }
        }
        return o;
      }
      case 6:
        arg(info);
        return read();
      default: // 7
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        if (info === 25) { const v = half(dv.getUint16(p)); p += 2; return v; }
        if (info === 26) { const v = dv.getFloat32(p); p += 4; return v; }
        if (info === 27) { const v = dv.getFloat64(p); p += 8; return v; }
        throw new Error('CBOR: unsupported simple value ' + info);
    }
  }

  return read();
}
