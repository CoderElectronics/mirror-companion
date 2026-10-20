// SMP (Simple Management Protocol) message format and the mcumgr serial
// (console) transport framing.
//
// SMP message = 8-byte header + CBOR body
//   [0] op (low 3 bits) | version << 3
//   [1] flags
//   [2..3] body length (BE)
//   [4..5] group id (BE)
//   [6] sequence number
//   [7] command id
//
// Serial framing: frame = len(BE16) + smp + crc16(smp)(BE16), where len counts
// smp + crc. The frame is split into 93-byte slices, each base64-encoded
// independently into one line: `06 09` + b64 for the first line, `04 14` + b64
// for continuations, terminated by '\n' (max 127 bytes per line).

import { encode, decode } from './cbor.js';

export const OP = { READ: 0, READ_RSP: 1, WRITE: 2, WRITE_RSP: 3 };
export const GROUP = { OS: 0, IMAGE: 1, FS: 8, CUSTOM: 64 };

const SLICE = 93;
const te = new TextEncoder();

export function crc16(data, crc = 0) {
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

// --- base64 (txiki.js has btoa/atob on strings only; do it on bytes directly)
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_REV = new Int16Array(256).fill(-1);
for (let i = 0; i < 64; i++) B64_REV[B64.charCodeAt(i)] = i;

function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    s += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    s += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return s;
}

function b64decode(bytes, start) {
  const out = [];
  let acc = 0;
  let bits = 0;
  for (let i = start; i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0x3d) break; // '='
    const v = B64_REV[c];
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}

/** Build an SMP message (header + CBOR body). */
export function buildSmp({ op, group, id, seq, body = {}, version = 0 }) {
  const payload = encode(body);
  const msg = new Uint8Array(8 + payload.length);
  msg[0] = (version << 3) | op;
  msg[1] = 0;
  msg[2] = payload.length >> 8;
  msg[3] = payload.length & 0xff;
  msg[4] = group >> 8;
  msg[5] = group & 0xff;
  msg[6] = seq;
  msg[7] = id;
  msg.set(payload, 8);
  return msg;
}

/** Length of the pre-base64 frame for an SMP message (what `mtu` bounds). */
export const frameSize = (smp) => smp.length + 4;

/** Wrap an SMP message in the serial transport: returns the bytes to write. */
export function encodeFrame(smp) {
  const frame = new Uint8Array(smp.length + 4);
  const len = smp.length + 2;
  frame[0] = len >> 8;
  frame[1] = len & 0xff;
  frame.set(smp, 2);
  const crc = crc16(smp);
  frame[frame.length - 2] = crc >> 8;
  frame[frame.length - 1] = crc & 0xff;

  let out = '';
  for (let off = 0; off < frame.length; off += SLICE) {
    const prefix = off === 0 ? '\x06\x09' : '\x04\x14';
    out += prefix + b64encode(frame.subarray(off, off + SLICE)) + '\n';
  }
  return te.encode(out);
}

/**
 * Incremental parser for the device -> host direction. Feed raw serial bytes;
 * `onMessage(smp)` fires for each complete, CRC-valid SMP message. Anything
 * that isn't a framed line (console/log output) is ignored.
 */
export class FrameParser {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.line = [];
    this.frame = null;
  }

  push(bytes) {
    for (const b of bytes) {
      if (b === 0x0a) {
        this.#handleLine(Uint8Array.from(this.line));
        this.line = [];
      } else if (b !== 0x0d) {
        this.line.push(b);
        if (this.line.length > 512) this.line = []; // runaway garbage
      }
    }
  }

  #handleLine(line) {
    if (line.length < 2) return;
    const start = line[0] === 0x06 && line[1] === 0x09;
    const cont = line[0] === 0x04 && line[1] === 0x14;
    if (!start && !cont) return;
    if (cont && !this.frame) return;

    const chunk = b64decode(line, 2);
    if (start) this.frame = Array.from(chunk);
    else for (const x of chunk) this.frame.push(x);

    if (this.frame.length < 2) return;
    const len = (this.frame[0] << 8) | this.frame[1];
    if (this.frame.length < len + 2) return;

    const body = Uint8Array.from(this.frame.slice(2, 2 + len));
    this.frame = null;
    if (len < 2 || crc16(body) !== 0) return; // crc over data+crc is 0 when valid
    this.onMessage(body.subarray(0, body.length - 2));
  }
}

/** Parse an SMP message into its header fields and decoded CBOR body. */
export function parseSmp(smp) {
  if (smp.length < 8) throw new Error('SMP message too short');
  const len = (smp[2] << 8) | smp[3];
  return {
    op: smp[0] & 0x07,
    version: (smp[0] >> 3) & 0x03,
    group: (smp[4] << 8) | smp[5],
    seq: smp[6],
    id: smp[7],
    body: len ? decode(smp.subarray(8, 8 + len)) : {},
  };
}
