// Raw serial port support for txiki.js (macOS + Linux).
//
// txiki.js has no serial API, so the port is configured with `stty` and then
// read/written as a plain character device. VMIN=0/VTIME=1 makes reads return
// every ~100ms, which lets the read loop notice a close request.

const dec = new TextDecoder();
// txiki.js exposes no platform string, so infer it from the device name:
// macOS names are `cu.*` / `tty.*` (with a dot), Linux's are `ttyUSB0`, `ttyACM0`, ...
const isMacPath = (path) => /^\/dev\/(cu|tty)\./.test(path);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function listPorts() {
  const re = /^((cu|tty)\.(?!Bluetooth-Incoming)|tty(USB|ACM|AMA|S)\d+)/;
  const out = [];
  const iter = await tjs.readDir('/dev');
  for await (const e of iter) {
    if (re.test(e.name)) out.push('/dev/' + e.name);
  }
  return out.sort();
}

async function configure(path, baudRate) {
  const flag = isMacPath(path) ? '-f' : '-F';
  const proc = tjs.spawn(
    ['stty', flag, path, String(baudRate), 'raw', '-echo', 'cs8', '-cstopb', '-parenb', 'clocal', 'cread', 'min', '0', 'time', '1'],
    { stdout: 'ignore', stderr: 'pipe' },
  );
  const errReader = proc.stderr.getReader();
  let err = '';
  for (;;) {
    const { value, done } = await errReader.read();
    if (done) break;
    err += dec.decode(value);
  }
  const status = await proc.wait();
  if (status.exit_status !== 0) throw new Error(`stty failed: ${err.trim() || 'exit ' + status.exit_status}`);
}

export class SerialPort {
  /**
   * @param {string} path  e.g. /dev/cu.usbmodem1101
   * @param {number} baudRate
   * @param {{ onData: (bytes: Uint8Array) => void, onClose?: (error: string | null) => void }} cb
   */
  static async open(path, baudRate, { onData, onClose = () => {} }) {
    if (!/^\/dev\/[\w.\-]+$/.test(path)) throw new Error('Invalid serial port path');
    // Open first, then configure: on macOS termios settings revert when the
    // last descriptor closes, so stty must run while we hold the port open.
    const handle = await tjs.open(path, 'r+');
    try {
      await configure(path, baudRate);
    } catch (e) {
      try { await handle.close(); } catch {}
      throw e;
    }
    const port = new SerialPort(path, baudRate, handle);

    (async () => {
      const buf = new Uint8Array(1024);
      let error = null;
      try {
        while (!port.closing) {
          const n = await handle.read(buf);
          if (n) onData(buf.slice(0, n));
          else await sleep(20);
        }
      } catch (e) {
        if (!port.closing) error = String(e.message ?? e);
      }
      try { await handle.close(); } catch {}
      port.closed = true;
      onClose(error);
    })();

    return port;
  }

  constructor(path, baudRate, handle) {
    this.path = path;
    this.baudRate = baudRate;
    this.handle = handle;
    this.closing = false;
    this.closed = false;
  }

  async write(bytes) {
    if (this.closing) throw new Error('Serial port is closed');
    let off = 0;
    while (off < bytes.length) off += await this.handle.write(bytes.subarray(off));
  }

  /** Stops the read loop and releases the device; never waits indefinitely. */
  async close() {
    this.closing = true;
    const deadline = Date.now() + 500;
    while (!this.closed && Date.now() < deadline) await sleep(10);
    if (!this.closed) {
      // Read loop is stuck in a blocking read: close the descriptor ourselves.
      this.closed = true;
      await Promise.race([this.handle.close().catch(() => {}), sleep(500)]);
    }
  }
}
