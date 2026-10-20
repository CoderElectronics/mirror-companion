// Backend: runs on txiki.js with full system access.
//
// Every function in `api` is callable from the page:
//   const result = await tiny.api.call('name', { ...params });

import { listPorts } from './serial.js';
import { McuMgr } from './mcumgr/client.js';
import { readMeta } from './mbin/meta.js';

let pushEvent = () => {};
let busy = false;

/** Run one mcumgr session at a time; the serial port is exclusive. */
async function withDevice({ port, baud = 115200, mtu }, fn) {
  if (busy) throw new Error('Another device operation is already running');
  if (!port) throw new Error('No serial port selected');
  busy = true;
  let mgr;
  try {
    mgr = await McuMgr.connect({ port, baud, mtu });
    return await fn(mgr);
  } finally {
    try { await mgr?.close(); } catch {}
    busy = false;
  }
}

/** Progress callback that pushes at most ~10 events/second. */
function progressPusher(extra) {
  let last = 0;
  return (done, total) => {
    const now = Date.now();
    if (done < total && now - last < 100) return;
    last = now;
    pushEvent('mcumgr:progress', { ...extra, done, total });
  };
}

export const api = {
  serialList: () => listPorts(),

  /**
   * mcumgr fs upload, for one or more files over a single connection.
   * files: [{ local: '/abs/path', remote: '/ext_storage/faces/x.mbin' }]
   */
  fsUpload: ({ port, baud, mtu = 256, files }) =>
    withDevice({ port, baud, mtu }, async (mgr) => {
      for (let i = 0; i < files.length; i++) {
        const { local, remote } = files[i];
        const bytes = await tjs.readFile(local);
        await mgr.fsUpload(bytes, remote, {
          onProgress: progressPusher({ kind: 'fs', file: remote, index: i, count: files.length }),
        });
      }
      return { uploaded: files.length };
    }),

  /** Size of a local file in bytes. */
  statFile: async ({ path }) => ({ size: (await tjs.stat(path)).size }),

  /** Header metadata (name, author, version, icon) of local .mbin files. */
  readMbinMeta: async ({ paths }) => Promise.all(paths.map((p) => readMeta(p).catch((e) => ({
    path: p, valid: false, magicOk: false, error: String(e.message ?? e),
  })))),

  /** Everything installed on the device: apps and faces. */
  listLibrary: ({ port, baud }) =>
    withDevice({ port, baud, mtu: 256 }, async (mgr) => ({
      apps: await mgr.fsList('/ext_storage/apps'),
      faces: await mgr.fsList('/ext_storage/faces'),
    })),

  /** Custom list command: file names in a device directory. */
  fsList: ({ port, baud, path }) =>
    withDevice({ port, baud, mtu: 256 }, async (mgr) => ({ files: await mgr.fsList(path) })),

  /** Custom delete command for one or more absolute device paths. */
  fsDelete: ({ port, baud, paths }) =>
    withDevice({ port, baud, mtu: 256 }, async (mgr) => {
      for (const p of paths) await mgr.fsDelete(p);
      return { deleted: paths.length };
    }),

  /** mcumgr image upload <local signed .bin> */
  imageUpload: ({ port, baud, mtu = 128, local }) =>
    withDevice({ port, baud, mtu }, async (mgr) => {
      const bytes = await tjs.readFile(local);
      await mgr.imageUpload(bytes, {
        onProgress: progressPusher({ kind: 'image', file: local, index: 0, count: 1 }),
      });
      return { size: bytes.length };
    }),

  /** mcumgr reset */
  reset: ({ port, baud }) =>
    withDevice({ port, baud, mtu: 128 }, async (mgr) => {
      await mgr.reset();
      return {};
    }),
};

export function init(app) {
  pushEvent = (name, data) => app.push(name, data);
}
