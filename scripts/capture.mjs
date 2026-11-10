// Drives the demo in headless Chrome over the DevTools protocol. No npm packages.
//   node scripts/capture.mjs shot  <out.png> "<query>" [width height] [warmupSeconds]
//   node scripts/capture.mjs video <outDir> [width height fps]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = pathToFileURL(join(ROOT, 'index.html')).href;
const PORT = 9300 + Math.floor(Math.random() * 500);

const [mode, out, ...rest] = process.argv.slice(2);
if (!['shot', 'video'].includes(mode) || !out) {
  console.error('usage: capture.mjs shot <out.png> "<query>" [w h warmup] | video <outDir> [w h fps]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(width, height) {
  const profile = mkdtempSync(join(tmpdir(), 'planet-forge-'));
  const child = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--force-device-scale-factor=1', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return { child, wsUrl: page.webSocketDebuggerUrl };
    } catch {}
    await sleep(250);
  }
  child.kill();
  throw new Error('Chrome did not expose a debugging endpoint');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { ok, bad } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? bad(new Error(msg.error.message)) : ok(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(`[console.${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(`[exception] ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
    }
  });
  const send = (method, params = {}) => new Promise((ok, bad) => {
    pending.set(++id, { ok, bad });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return new Promise((ok) => ws.addEventListener('open', () => ok({ send, logs, close: () => ws.close() })));
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function open(cdp, query, width, height) {
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${PAGE}?${query}` });
  for (let i = 0; i < 80; i++) {
    await sleep(150);
    const ready = await evaluate(cdp, '!!window.planetForge || (window.__errors || []).join("\\n")').catch(() => false);
    if (ready === true) return;
    if (ready) throw new Error(`page reported: ${ready}`);
  }
  throw new Error('page never became ready');
}

async function screenshot(cdp, file) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(data, 'base64'));
}

async function main() {
  if (mode === 'shot') {
    const [query = 'capture&clean', w = '1600', h = '900', warmup = '0'] = rest;
    const width = Number(w), height = Number(h);
    const { child, wsUrl } = await launch(width, height);
    try {
      const cdp = await connect(wsUrl);
      await open(cdp, query, width, height);
      const info = await evaluate(cdp, `(() => { const n = Math.round(${Number(warmup)} * 30); for (let i = 0; i < n; i++) planetForge.step(1 / 30); planetForge.step(0);
        const gl = document.getElementById('gl').getContext('webgl2'); const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'n/a', state: planetForge.state(), errors: window.__errors || [] }; })()`);
      await screenshot(cdp, out);
      console.log(JSON.stringify(info));
      if (cdp.logs.length) console.log(cdp.logs.join('\n'));
      cdp.close();
    } finally {
      child.kill();
    }
    return;
  }

  const [w = '1920', h = '1080', f = '30'] = rest;
  const width = Number(w), height = Number(h), fps = Number(f);
  mkdirSync(out, { recursive: true });
  const { child, wsUrl } = await launch(width, height);
  try {
    const cdp = await connect(wsUrl);
    await open(cdp, 'capture&clean', width, height);
    const end = await evaluate(cdp, 'planetForge.startTour(), planetForge.tourEnd');
    const frames = Math.round(end * fps) - 1;
    const started = Date.now();
    for (let i = 0; i < frames; i++) {
      await evaluate(cdp, `planetForge.step(${1 / fps})`);
      await screenshot(cdp, join(out, `f${String(i).padStart(5, '0')}.png`));
      if (i % 60 === 0) console.log(`frame ${i}/${frames}  ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
    if (cdp.logs.length) console.log(cdp.logs.join('\n'));
    console.log(`done: ${frames} frames in ${((Date.now() - started) / 1000).toFixed(0)}s`);
    cdp.close();
  } finally {
    child.kill();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
