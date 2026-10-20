// Reader for the metadata header the packer prepends to .mbin files.
//
// Layout (little-endian, packed, 56 bytes):
//   u32  magic      (0x324D5655)
//   u16  version
//   18s  icon       12x12 bitmap, row-major, MSB first (1 = pixel on)
//   16s  name       NUL padded
//   16s  author     NUL padded

export const HEADER_SIZE = 56;
export const MAGIC = 0x324d5655;

const dec = new TextDecoder();

const cstr = (bytes) => {
  const end = bytes.indexOf(0);
  return dec.decode(end < 0 ? bytes : bytes.subarray(0, end));
};

export function parseHeader(bytes) {
  if (bytes.length < HEADER_SIZE) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const icon = [];
  for (let row = 0; row < 12; row++) {
    let s = '';
    for (let col = 0; col < 12; col++) {
      const i = row * 12 + col;
      s += (bytes[6 + (i >> 3)] >> (7 - (i & 7))) & 1 ? '1' : '0';
    }
    icon.push(s);
  }
  return {
    magic: dv.getUint32(0, true),
    magicOk: dv.getUint32(0, true) === MAGIC,
    version: dv.getUint16(4, true),
    icon,
    name: cstr(bytes.subarray(24, 40)),
    author: cstr(bytes.subarray(40, 56)),
  };
}

/** Read just the header of a local file (plus its total size). */
export async function readMeta(path) {
  const size = (await tjs.stat(path)).size;
  let header = null;
  const f = await tjs.open(path, 'r');
  try {
    const buf = new Uint8Array(HEADER_SIZE);
    let got = 0;
    while (got < HEADER_SIZE) {
      const n = await f.read(buf.subarray(got));
      if (!n) break;
      got += n;
    }
    header = parseHeader(buf.subarray(0, got));
  } finally {
    await f.close();
  }
  return { path, size, ...(header ?? { magicOk: false, valid: false }), valid: !!header };
}
