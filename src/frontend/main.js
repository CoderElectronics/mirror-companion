import './style.css';
import Alpine from 'alpinejs';

window.Alpine = Alpine;

const DIRS = { faces: '/ext_storage/faces', apps: '/ext_storage/apps' };
const BAUD = 115200;
const basename = (p) => p.split(/[\\/]/).pop();

Alpine.data('companion', () => ({
  ports: [],
  port: localStorage.getItem('port') ?? '',
  connected: false,
  connecting: false,
  connectError: '',
  busy: false,
  progress: 0,
  library: null, // [{ kind: 'face'|'app', name, label, path }]
  pending: null, // files staged in the add popover
  toasts: [],
  fw: null, // firmware popover: { path, size, uploaded }
  fwOpen: false,
  basename,

  async init() {
    tiny.api.on('mcumgr:progress', ({ index, count, done, total }) => {
      const frac = total ? done / total : 1;
      this.progress = Math.floor(((index + frac) / count) * 100);
    });
    tiny.win.onDrop((paths) => (this.fwOpen ? this.setFirmware(paths) : this.stage(paths)));

    await this.refreshPorts();
    if (this.port) await this.connect();
  },

  get validPending() {
    return (this.pending ?? []).filter((f) => f.valid);
  },

  toast(text, error = false) {
    const id = Math.random();
    this.toasts.push({ id, text, error, visible: false });
    // Compare by id: array items are reactive proxies, never `===` the raw object.
    const find = () => this.toasts.find((x) => x.id === id);
    requestAnimationFrame(() => { const t = find(); if (t) t.visible = true; });
    setTimeout(() => {
      const t = find();
      if (t) t.visible = false;
      setTimeout(() => { this.toasts = this.toasts.filter((x) => x.id !== id); }, 500);
    }, error ? 6000 : 2500);
  },

  // --- connection -------------------------------------------------------

  async refreshPorts() {
    try {
      const all = await tiny.api.call('serialList');
      // Prefer callout (cu.*) devices; skip tty.* duplicates and system noise.
      this.ports = all.filter((p) => !p.includes('/tty.') && !/debug-console|Bluetooth/.test(p));
      if (this.port && !this.ports.includes(this.port)) this.port = '';
    } catch (e) {
      this.connectError = String(e.message ?? e);
    }
  },

  async connect() {
    if (!this.port || this.connecting) return;
    this.connecting = true;
    this.connectError = '';
    try {
      await this.fetchLibrary();
      this.connected = true;
    } catch (e) {
      this.connectError = String(e.message ?? e);
    } finally {
      this.connecting = false;
    }
  },

  disconnect() {
    this.connected = false;
    this.library = null;
    this.pending = null;
    this.fwOpen = false;
    this.fw = null;
  },

  // --- firmware ---------------------------------------------------------

  openFirmware() {
    this.fw = null;
    this.fwOpen = true;
  },

  closeFirmware() {
    if (this.busy) return;
    this.fwOpen = false;
    this.fw = null;
  },

  async browseFirmware() {
    const path = await tiny.dialog.openFile({ types: ['bin'] });
    if (path) await this.setFirmware([path]);
  },

  async setFirmware(paths) {
    if (this.busy) return;
    const path = paths.find((p) => p.toLowerCase().endsWith('.bin'));
    if (!path) return this.toast('Choose a signed firmware .bin file', true);
    try {
      const { size } = await tiny.api.call('statFile', { path });
      this.fw = { path, size, uploaded: false };
    } catch (e) {
      this.toast(String(e.message ?? e), true);
    }
  },

  async submitFirmware() {
    if (!this.fw) return;
    const ok = await this.run(() =>
      tiny.api.call('imageUpload', { port: this.port, baud: BAUD, local: this.fw.path }),
    );
    if (ok) {
      this.fw.uploaded = true;
      this.toast('Firmware uploaded');
    }
  },

  async resetDevice() {
    if (!(await tiny.dialog.confirm('Reset the device?', { ok: 'Reset' }))) return;
    const ok = await this.run(() => tiny.api.call('reset', { port: this.port, baud: BAUD }));
    if (ok) {
      this.toast('Device is resetting');
      this.fwOpen = false;
      this.fw = null;
    }
  },

  // --- device library ---------------------------------------------------

  async fetchLibrary() {
    const { apps, faces } = await tiny.api.call('listLibrary', { port: this.port, baud: BAUD });
    const make = (kind, dir, name) => ({
      kind,
      name,
      label: name.replace(/\.mbin$/i, ''),
      path: `${dir}/${name}`,
    });
    const sort = (a, b) => a.localeCompare(b);
    this.library = [
      ...faces.sort(sort).map((n) => make('face', DIRS.faces, n)),
      ...apps.sort(sort).map((n) => make('app', DIRS.apps, n)),
    ];
  },

  // Run a device operation with busy tracking and error toasts.
  async run(fn) {
    if (this.busy) return false;
    this.busy = true;
    this.progress = 0;
    try {
      await fn();
      return true;
    } catch (e) {
      this.toast(String(e.message ?? e), true);
      return false;
    } finally {
      this.busy = false;
    }
  },

  async loadLibrary() {
    await this.run(() => this.fetchLibrary());
  },

  async remove(item) {
    const ok = await tiny.dialog.confirm(`Delete ${item.label}?`, {
      ok: 'Delete',
      detail: `${item.path} will be removed from the device.`,
    });
    if (!ok) return;
    const done = await this.run(async () => {
      await tiny.api.call('fsDelete', { port: this.port, baud: BAUD, paths: [item.path] });
      await this.fetchLibrary();
    });
    if (done) this.toast(`Deleted ${item.label}`);
  },

  // --- adding files -----------------------------------------------------

  async browse() {
    const paths = await tiny.dialog.openFiles({ types: ['mbin'] });
    if (paths?.length) await this.stage(paths);
  },

  async stage(paths) {
    if (!this.connected || this.busy || this.fwOpen) return;
    const files = paths.filter((p) => p.toLowerCase().endsWith('.mbin'));
    if (files.length !== paths.length) this.toast('Only .mbin files can be added', true);
    if (!files.length) return;

    try {
      const metas = await tiny.api.call('readMbinMeta', { paths: files });
      this.pending = metas.map((m) => ({
        ...m,
        target: 'faces',
        cells: m.icon ? m.icon.join('').split('').map((c) => c === '1') : Array(144).fill(false),
      }));
    } catch (e) {
      this.toast(String(e.message ?? e), true);
    }
  },

  exists(f) {
    const kind = f.target === 'apps' ? 'app' : 'face';
    return !!this.library?.some((i) => i.kind === kind && i.name === basename(f.path));
  },

  closeAdd() {
    if (!this.busy) this.pending = null;
  },

  async submitAdd() {
    const files = this.validPending.map((f) => ({
      local: f.path,
      remote: `${DIRS[f.target]}/${basename(f.path)}`,
    }));
    if (!files.length) return;

    const ok = await this.run(async () => {
      await tiny.api.call('fsUpload', { port: this.port, baud: BAUD, files });
      await this.fetchLibrary();
    });
    if (ok) {
      this.pending = null;
      this.toast(`Added ${files.length} file${files.length === 1 ? '' : 's'}`);
    }
  },

  fmtSize(n) {
    return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
  },
}));

Alpine.start();
