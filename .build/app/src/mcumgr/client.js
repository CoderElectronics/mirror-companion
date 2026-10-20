// A small JS port of the `mcumgr` CLI over the serial transport.
//
//   const mgr = await McuMgr.connect({ port: '/dev/cu.usbmodem1101', baud: 115200, mtu: 256 });
//   try { await mgr.fsUpload(bytes, '/ext_storage/faces/a.mbin'); } finally { await mgr.close(); }
//
// Equivalent CLI commands:
//   mcumgr --conntype serial --connstring "dev=P,baud=115200,mtu=256" fs upload FILE REMOTE
//   mcumgr --conntype serial --connstring "dev=P,baud=115200" image upload app.signed.bin
//   mcumgr --conntype serial --connstring "dev=P,baud=115200" reset

import { SerialPort } from '../serial.js';
import { OP, GROUP, buildSmp, encodeFrame, frameSize, FrameParser, parseSmp } from './smp.js';

const ID = {
  OS_RESET: 5,
  IMAGE_UPLOAD: 1,
  FS_FILE: 0,
  // Custom group (64) implemented in the Zephyr app's mgmt_handlers.c
  CUSTOM_LIST_FILES: 0,
  CUSTOM_DELETE_FILE: 1,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Zephyr's SMP v2 error responses carry { err: { group, rc } }, v1 uses { rc }.
function checkResponse(body, what) {
  if (body && typeof body === 'object') {
    if (body.err && body.err.rc) throw new Error(`${what} failed: group ${body.err.group} rc ${body.err.rc}`);
    if (body.rc) throw new Error(`${what} failed: rc ${body.rc}`);
  }
  return body;
}

export class McuMgr {
  static async connect({ port, baud = 115200, mtu = 128 }) {
    const mgr = new McuMgr(mtu);
    mgr.port = await SerialPort.open(port, baud, {
      onData: (bytes) => mgr.parser.push(bytes),
      onClose: (err) => mgr.#onPortClosed(err),
    });
    return mgr;
  }

  constructor(mtu) {
    this.mtu = mtu;
    this.seq = 0;
    this.pending = null; // { seq, resolve, reject, timer }
    this.parser = new FrameParser((smp) => this.#onMessage(smp));
  }

  #onMessage(smp) {
    let msg;
    try {
      msg = parseSmp(smp);
    } catch {
      return;
    }
    const p = this.pending;
    if (!p || msg.seq !== p.seq) return;
    clearTimeout(p.timer);
    this.pending = null;
    p.resolve(msg);
  }

  #onPortClosed(err) {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    p.reject(new Error(err ? `Serial port error: ${err}` : 'Serial port closed'));
  }

  nextSeq() {
    const s = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    return s;
  }

  /** Send an SMP request and await the response with the matching sequence. */
  async request({ op, group, id, body, timeout = 5000, seq = this.nextSeq() }) {
    const smp = buildSmp({ op, group, id, seq, body });
    return this.#send(smp, seq, timeout);
  }

  async #send(smp, seq, timeout) {
    if (this.pending) throw new Error('A request is already in flight');
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error('Timed out waiting for the device to respond'));
      }, timeout);
      this.pending = { seq, resolve, reject, timer };
    });
    try {
      await this.port.write(encodeFrame(smp));
    } catch (e) {
      clearTimeout(this.pending?.timer);
      this.pending = null;
      throw e;
    }
    return response;
  }

  /**
   * Chunked upload shared by `fs upload` and `image upload`. `build(off, data)`
   * returns the CBOR body for one packet; the largest `data` slice whose
   * serialized frame fits within `mtu` is chosen for each packet.
   */
  async #upload({ group, id, bytes, build, label, onProgress, firstTimeout = 5000 }) {
    const total = bytes.length;
    let off = 0;
    let first = true;
    onProgress?.(0, total);

    while (off < total) {
      const seq = this.nextSeq();
      let n = Math.min(total - off, this.mtu);
      let smp;
      for (;;) {
        if (n <= 0) throw new Error(`MTU ${this.mtu} is too small for ${label}`);
        smp = buildSmp({ op: OP.WRITE, group, id, seq, body: build(off, bytes.subarray(off, off + n)) });
        const excess = frameSize(smp) - this.mtu;
        if (excess <= 0) break;
        n -= excess;
      }

      const rsp = await this.#send(smp, seq, first ? firstTimeout : 5000);
      checkResponse(rsp.body, label);
      first = false;

      // The device reports the next offset it expects (also enables resume).
      const next = typeof rsp.body.off === 'number' ? rsp.body.off : off + n;
      if (next > total) throw new Error(`${label}: device returned invalid offset ${next}`);
      off = next;
      onProgress?.(off, total);
    }
  }

  /** `fs upload <file> <remote path>` */
  async fsUpload(bytes, remotePath, { onProgress } = {}) {
    if (!remotePath.startsWith('/')) throw new Error('Remote path must be absolute');
    await this.#upload({
      group: GROUP.FS,
      id: ID.FS_FILE,
      bytes,
      label: `fs upload ${remotePath}`,
      onProgress,
      build: (off, data) => {
        const body = { off, data, name: remotePath };
        if (off === 0) body.len = bytes.length;
        return body;
      },
    });
  }

  /** `image upload <signed.bin>` (slot `image`, default 0). */
  async imageUpload(bytes, { image = 0, onProgress } = {}) {
    await this.#upload({
      group: GROUP.IMAGE,
      id: ID.IMAGE_UPLOAD,
      bytes,
      label: 'image upload',
      onProgress,
      firstTimeout: 30000, // first packet may trigger a flash erase
      build: (off, data) => {
        const body = { off, data };
        if (off === 0) {
          body.len = bytes.length;
          if (image > 0) body.image = image;
        }
        return body;
      },
    });
  }

  /** Custom group: list the regular files (names only) in a device directory. */
  async fsList(path) {
    const rsp = await this.request({
      op: OP.READ,
      group: GROUP.CUSTOM,
      id: ID.CUSTOM_LIST_FILES,
      body: { path },
    });
    checkResponse(rsp.body, `list ${path}`);
    return Array.isArray(rsp.body.files) ? rsp.body.files : [];
  }

  /** Custom group: delete a file on the device. */
  async fsDelete(path) {
    const rsp = await this.request({
      op: OP.WRITE,
      group: GROUP.CUSTOM,
      id: ID.CUSTOM_DELETE_FILE,
      body: { path },
    });
    checkResponse(rsp.body, `delete ${path}`);
  }

  /** `reset` — the device may reboot before (or instead of) answering. */
  async reset() {
    try {
      const rsp = await this.request({ op: OP.WRITE, group: GROUP.OS, id: ID.OS_RESET, body: {}, timeout: 3000 });
      checkResponse(rsp.body, 'reset');
    } catch (e) {
      if (!/Timed out|closed/.test(String(e.message))) throw e;
    }
    await sleep(100);
  }

  async close() {
    await this.port.close();
  }
}
