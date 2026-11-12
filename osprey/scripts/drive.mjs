// Drives Osprey in headless Chrome over the DevTools protocol, for development: open a sample,
// switch views, click at board coordinates in mm, press keys, type into inspector fields, take
// screenshots, and read the editor's state from the dev-only `window.__osprey` hook
// (src/main.ts). Used by the UI tests (test/ui) and from the command line:
//
//   node scripts/drive.mjs open:wwvbfind.osprey/board click:10,20 key:w shot:out.png state
//
// Steps (run in order; coordinates are world mm, y up):
//   open:<sample>[/board]     open a sample (as in the Samples menu, e.g. TA7358A.osprey)
//   view:board|schematic      switch view
//   click:x,y[,shift|ctrl|alt|right|double]...   click (double: a double click)
//   move:x,y                  move the pointer
//   drag:x1,y1,x2,y2          drag with the left button
//   key:<key>                 press a key: w, Escape, Enter, Shift+L, Ctrl+z, Delete, Tab …
//   type:<field>=<text>       type into an inspector field (name, value, net, x, y …) + Enter
//   button:<text or #id>      click a button (or other element) by its text or id
//   choose:<#id>=<value>      choose an option of a <select>
//   wait:<ms>                 wait
//   shot:<file.png>           screenshot of the page
//   state                     print the editor's state (JSON)
//   eval:<expression>         print the value of an expression in the page (__osprey is the hook)
//
// Options: --url <dev server> (default: start one), --size <w>x<h> (default 1400x900),
// --chrome <path> (or CHROME_PATH). Console errors and uncaught exceptions in the page are
// printed at the end, and make the exit status 1.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Chrome, Edge or Chromium, from CHROME_PATH or the usual install locations. */
export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const pf = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = {
    win32: pf.flatMap((d) => [join(d, 'Google/Chrome/Application/chrome.exe'), join(d, 'Microsoft/Edge/Application/msedge.exe')]),
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
  }[process.platform] ?? [];
  return candidates.find((p) => existsSync(p));
}

/** A DevTools protocol connection to the browser; `session` addresses one page. */
class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = [];

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`Can't connect to ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p?.resolve(msg.result);
      } else for (const fn of this.#listeners) fn(msg);
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject, method }));
  }

  on(fn) {
    this.#listeners.push(fn);
  }

  close() {
    this.#ws.close();
  }
}

const MODIFIERS = { alt: 1, ctrl: 2, control: 2, meta: 4, shift: 8 };

/** DevTools key fields for a key name ("w", "Escape", "Shift+L"). */
function keyEvent(spec) {
  const parts = spec.split('+');
  // "+" itself, or a combination ending in it ("Shift++").
  const name = spec.endsWith('++') || spec === '+' ? '+' : parts.pop();
  let modifiers = 0;
  for (const m of spec === '+' ? [] : parts.filter(Boolean)) {
    const bit = MODIFIERS[m.toLowerCase()];
    if (!bit) throw new Error(`Unknown modifier "${m}" in "${spec}"`);
    modifiers |= bit;
  }
  const shift = (modifiers & 8) !== 0;
  const special = {
    Escape: 27, Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Home: 36, End: 35, ' ': 32, Space: 32,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PageUp: 33, PageDown: 34,
  };
  if (name in special) {
    const key = name === 'Space' ? ' ' : name;
    const text = key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined;
    return { key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: special[name], modifiers, text };
  }
  if (name.length !== 1) throw new Error(`Unknown key "${name}"`);
  const letter = /[a-z]/i.test(name);
  const key = letter ? (shift ? name.toUpperCase() : name.toLowerCase()) : name;
  const vk = letter ? name.toUpperCase().charCodeAt(0) : /[0-9]/.test(name) ? name.charCodeAt(0) : { '/': 191, '.': 190, ',': 188, '-': 189, '=': 187, '+': 187 }[name] ?? 0;
  const code = letter ? `Key${name.toUpperCase()}` : /[0-9]/.test(name) ? `Digit${name}` : undefined;
  // Text only for plain or shifted typing: with Ctrl/Alt/Meta it is a shortcut.
  const text = modifiers & 7 ? undefined : key;
  return { key, ...(code ? { code } : {}), windowsVirtualKeyCode: vk, modifiers, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start Osprey in headless Chrome. Starts a Vite dev server unless `url` is given (then that
 * server is used, e.g. one started with `npm run dev`). Close it with `close()`.
 */
export async function launch({ url, width = 1400, height = 900, chrome = findChrome(), headless = true } = {}) {
  if (!chrome) throw new Error('No Chrome, Edge or Chromium found; set CHROME_PATH');
  let server;
  if (!url) {
    const { createServer } = await import('vite');
    server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false } });
    await server.listen();
    url = server.resolvedUrls.local[0];
  }

  const profile = mkdtempSync(join(tmpdir(), 'osprey-drive-'));
  const proc = spawn(chrome, [
    ...(headless ? ['--headless=new'] : []),
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu',
    '--hide-scrollbars', '--mute-audio', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => reject(new Error(`Chrome didn't start:\n${err}`)), 20000);
    proc.stderr.on('data', (d) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on('exit', () => reject(new Error(`Chrome exited:\n${err}`)));
  });

  const cdp = await Cdp.connect(wsUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);

  const problems = [];
  const loads = [];
  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      problems.push(`Uncaught: ${d.exception?.description ?? d.text}`);
    } else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      problems.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    } else if (msg.method === 'Page.javascriptDialogOpening') {
      // Leaving a page with unsaved edits asks first (beforeunload): leave.
      void send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    } else if (msg.method === 'Page.loadEventFired') {
      loads.splice(0).forEach((fn) => fn());
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  /** The value of an expression in the page (awaited if it's a promise). */
  async function evaluate(expression) {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(`${expression}: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    return res.result.value;
  }
  const call = (fn, ...args) => evaluate(`(${fn})(${args.map((a) => JSON.stringify(a)).join(',')})`);

  /** Until the page has drawn what the last input did: two animation frames. */
  const settle = () => evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');

  async function waitFor(fn, what, timeout = 15000, ...args) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = await call(fn, ...args).catch(() => undefined);
      if (v) return v;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
      await sleep(50);
    }
  }

  let pointer = { x: 0, y: 0 };
  let buttons = 0;
  const mouse = (type, p, opts = {}) =>
    send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, modifiers: opts.modifiers ?? 0, button: opts.button ?? 'none', buttons, clickCount: opts.clickCount ?? 0 });
  const page = (x, y) => call((x, y) => window.__osprey.toPage(x, y), x, y);

  async function clickAt(p, { button = 'left', modifiers = 0, double = false } = {}) {
    const bit = { left: 1, right: 2, middle: 4 }[button];
    await mouse('mouseMoved', p, { modifiers });
    for (let n = 1; n <= (double ? 2 : 1); n++) {
      buttons = bit;
      await mouse('mousePressed', p, { button, modifiers, clickCount: n });
      buttons = 0;
      await mouse('mouseReleased', p, { button, modifiers, clickCount: n });
    }
    pointer = p;
    await settle();
  }

  /** The centre of an element in the page, found by "#id", a CSS selector, or its text. */
  const elementCentre = (target) =>
    waitFor((target) => {
      const byText = () =>
        [...document.querySelectorAll('button, [role=button], summary, label, a, li, div.library-list > *')]
          .filter((e) => e.offsetParent !== null)
          .find((e) => e.textContent.trim() === target) ??
        [...document.querySelectorAll('button')].filter((e) => e.offsetParent !== null).find((e) => e.textContent.trim().startsWith(target));
      let el;
      try { el = /^[#.[]/.test(target) ? document.querySelector(target) : byText(); } catch { el = byText(); }
      if (!el || el.offsetParent === null) return undefined;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, `"${target}" on the page`, 5000, target);

  const driver = {
    url,
    send,
    evaluate,
    settle,
    waitFor: (fn, what, timeout, ...args) => waitFor(fn, what, timeout, ...args),

    /** Problems the page reported: uncaught exceptions, console errors and warnings. */
    problems,

    /** Open a sample, e.g. "wwvbfind.osprey" or "TA7358A.sch+brd", in the board or schematic view. */
    /** Load a page and wait for its load event (a fresh load, even if only the hash differs). */
    async goto(to) {
      for (const u of ['about:blank', to]) {
        const loaded = new Promise((r) => loads.push(r));
        const res = await send('Page.navigate', { url: u });
        if (res.errorText) throw new Error(`${u}: ${res.errorText}`);
        await loaded;
      }
    },

    async open(sample, view) {
      await driver.goto(`${url}#${encodeURIComponent(sample)}${view ? `/${view}` : ''}`);
      const s = await waitFor(
        (sample) => { const s = window.__osprey?.state(); return s?.loaded && s.sample === sample && s; },
        `${sample} to open`, 15000, sample,
      ).catch(async (e) => {
        const err = await evaluate('document.getElementById("error-text")?.textContent').catch(() => '');
        throw err ? new Error(`${sample}: ${err}`) : e;
      });
      if (view && s.view !== view) await driver.view(view);
      await settle();
    },

    async view(kind) {
      await driver.button(`#view-toggle [data-view="${kind}"]`);
      await waitFor((kind) => window.__osprey.state().view === kind, `the ${kind} view`, 5000, kind);
    },

    /** Click at a world point (mm). */
    async click(x, y, opts) {
      await clickAt(await page(x, y), opts);
    },

    async dblclick(x, y, opts = {}) {
      await clickAt(await page(x, y), { ...opts, double: true });
    },

    /** Move the pointer to a world point (mm), in `steps` moves from where it was. */
    async move(x, y, { steps = 1, modifiers = 0 } = {}) {
      const to = await page(x, y);
      const from = pointer;
      for (let i = 1; i <= steps; i++) {
        await mouse('mouseMoved', { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }, { modifiers, button: buttons ? 'left' : 'none' });
      }
      pointer = to;
      await settle();
    },

    /** Drag with the left button from one world point to another. */
    async drag(x1, y1, x2, y2, { modifiers = 0, steps = 8 } = {}) {
      const from = await page(x1, y1);
      await mouse('mouseMoved', from, { modifiers });
      buttons = 1;
      await mouse('mousePressed', from, { button: 'left', modifiers, clickCount: 1 });
      pointer = from;
      await driver.move(x2, y2, { steps, modifiers });
      buttons = 0;
      await mouse('mouseReleased', pointer, { button: 'left', modifiers, clickCount: 1 });
      await settle();
    },

    /** Press a key: "w", "Escape", "Shift+L", "Ctrl+z". */
    async key(spec) {
      const k = keyEvent(spec);
      await send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...k });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k, text: undefined });
      await settle();
    },

    /** Type into an inspector field (data-field: name, value, net, x, y …) and press Enter. */
    async type(field, text) {
      const p = await elementCentre(`#inspector input[data-field="${field}"]`);
      await clickAt(p);
      await evaluate('document.activeElement.select()');
      await send('Input.insertText', { text });
      await driver.key('Enter');
    },

    /** Click a button or other element, by its text or a selector ("#drc-run"). */
    async button(target) {
      await clickAt(await elementCentre(target));
    },

    /** Choose an option of a select, by value or label. */
    async choose(selector, value) {
      const ok = await call((selector, value) => {
        const s = document.querySelector(selector);
        const o = s && [...s.options].find((o) => o.value === value || o.label === value);
        if (!o) return false;
        s.value = o.value;
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, selector, value);
      if (!ok) throw new Error(`No option "${value}" in ${selector}`);
      await settle();
    },

    /**
     * Save files the page saves into `dir`, as downloads: the save dialog (File System Access)
     * is turned off, so Save and Export download instead.
     */
    async downloads(dir) {
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
      await evaluate('window.showSaveFilePicker = undefined');
    },

    /** The editor's state (see the hook in src/main.ts). */
    state: () => evaluate('window.__osprey.state()'),

    /** Save a PNG of the page. */
    async shot(file) {
      await settle();
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(file, Buffer.from(data, 'base64'));
    },

    async close() {
      try { cdp.close(); } catch { /* already closed */ }
      proc.kill();
      await new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
      await server?.close();
      // Chrome may hold the profile briefly after exiting.
      for (let i = 0; i < 10; i++) {
        try { rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(200); }
      }
    },
  };
  return driver;
}

// ---------------------------------------------------------------------------
// Command line

async function main(argv) {
  const opts = {};
  const steps = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') opts.url = argv[++i];
    else if (a === '--chrome') opts.chrome = argv[++i];
    else if (a === '--headed') opts.headless = false;
    else if (a === '--size') [opts.width, opts.height] = argv[++i].split('x').map(Number);
    else steps.push(a);
  }
  if (!steps.length) {
    console.log('Usage: node scripts/drive.mjs [--url URL] [--size WxH] step...  (steps: see the top of scripts/drive.mjs)');
    return 0;
  }
  const d = await launch(opts);
  const nums = (s) => s.split(',').slice(0, 2).map(Number);
  const flags = (s) => {
    const f = new Set(s.split(',').slice(2));
    return {
      button: f.has('right') ? 'right' : 'left',
      modifiers: (f.has('alt') ? 1 : 0) | (f.has('ctrl') ? 2 : 0) | (f.has('shift') ? 8 : 0),
      double: f.has('double'),
    };
  };
  try {
    for (const step of steps) {
      const at = step.indexOf(':');
      const verb = at < 0 ? step : step.slice(0, at);
      const arg = at < 0 ? '' : step.slice(at + 1);
      switch (verb) {
        case 'open': { const [s, v] = arg.split('/'); await d.open(s, v); break; }
        case 'view': await d.view(arg); break;
        case 'click': await d.click(...nums(arg), flags(arg)); break;
        case 'dblclick': await d.dblclick(...nums(arg), flags(arg)); break;
        case 'move': await d.move(...nums(arg)); break;
        case 'drag': await d.drag(...arg.split(',').map(Number)); break;
        case 'key': await d.key(arg); break;
        case 'type': { const eq = arg.indexOf('='); await d.type(arg.slice(0, eq), arg.slice(eq + 1)); break; }
        case 'button': await d.button(arg); break;
        // The selector may hold an "=" (an attribute selector): the value follows the last one.
        case 'choose': { const eq = arg.lastIndexOf('='); await d.choose(arg.slice(0, eq), arg.slice(eq + 1)); break; }
        case 'wait': await sleep(Number(arg)); break;
        case 'shot': await d.shot(arg); console.log(`Saved ${arg}`); break;
        case 'state': console.log(JSON.stringify(await d.state(), null, 2)); break;
        case 'eval': console.log(JSON.stringify(await d.evaluate(arg), null, 2)); break;
        default: throw new Error(`Unknown step "${step}"`);
      }
    }
  } finally {
    await d.close();
  }
  for (const p of d.problems) console.error(p);
  return d.problems.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
