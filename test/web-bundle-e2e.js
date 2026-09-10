'use strict';
// End-to-end test of the BROWSER BUNDLE against a C++ provider.
//
// Three things are on trial here, and only this test can put them there:
//
//   (a) the bundle is BROWSER code. It is loaded into a vm context that has no
//       require, no process, no Buffer and no Node builtin of any kind - only
//       what a page has. Anything the SDK reached for out of Node would throw
//       here rather than in somebody's browser six months from now.
//   (b) the wire is the REAL web transport. The far end is logos-web-shim: a
//       C++ ModuleProxy published on logos::web::WebTransportHost, reached
//       through a CHANNEL SHIM - the browser SDK's channel bound to a child
//       process's stdio instead of to a webview's postMessage. Both sides
//       encode `{_bytes}` themselves, so a base64url disagreement shows up as a
//       failed assertion rather than as a corrupt payload.
//   (c) a typed client GENERATED from calc.lidl drives that same bundled
//       consumer.
//
// Environment:
//   LOGOS_WEB_BUNDLE_DIR  dist directory holding logos-web.js + logos-web.mjs
//   LOGOS_WEB_SHIM        path to the logos-web-shim executable
//   LOGOS_LIDL_LIB        shared liblogos_lidl_c (for the codegen leg)
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { newlineStreamChannel } = require('../src/web/node-channel.js');

const BUNDLE_DIR = process.env.LOGOS_WEB_BUNDLE_DIR || path.join(__dirname, '..', 'dist');
const SHIM = process.env.LOGOS_WEB_SHIM;
const MODULE_NAME = 'calc_cpp';
const TOKEN = 'web-shim-tok';

function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, budgetMs, what) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(10);
  }
  throw new Error(`timed out after ${budgetMs}ms waiting for ${what}`);
}

// -- (a) the bundle, in a context that is deliberately NOT Node --------------
function loadBundle() {
  const file = path.join(BUNDLE_DIR, 'logos-web.js');
  assert(fs.existsSync(file), `browser bundle at ${file} (build it: npm run build:web)`);
  const code = fs.readFileSync(file, 'utf8');

  // A page's globals, and nothing else. No require, no process, no Buffer, no
  // TextEncoder even - if the SDK needs one it has to say so out loud.
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context, { filename: 'logos-web.js' });

  const sdk = context.LogosWeb;
  assert(sdk && typeof sdk.WebClient === 'function',
    'the IIFE bundle exposes a global LogosWeb with a WebClient');
  return sdk;
}

function startShim() {
  assert(SHIM && fs.existsSync(SHIM), `LOGOS_WEB_SHIM points at the shim binary (got ${SHIM})`);
  const child = spawn(SHIM, ['--module', MODULE_NAME, '--token', TOKEN, '--tick-ms', '100'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const ready = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('the shim did not print READY in 20s')), 20000);
    let buf = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      buf += d;
      process.stderr.write(`[shim] ${d}`);
      if (buf.includes('READY')) { clearTimeout(to); resolve(); }
    });
    child.on('exit', (code) => { clearTimeout(to); reject(new Error(`the shim exited early (${code})`)); });
  });
  return { child, ready };
}

async function main() {
  console.log('=== logos-js-sdk browser bundle <-> C++ provider on the web transport ===\n');

  const sdk = loadBundle();
  console.log('OK  bundle loaded in a browser-only context (no require/process/Buffer)');

  const { child, ready } = startShim();
  await ready;

  // The channel SHIM: the browser SDK's channel, bound to the child's stdio.
  // Everything above this line is the same code a webview would run.
  const channel = newlineStreamChannel({ input: child.stdout, output: child.stdin });
  const logos = new sdk.WebClient('web_consumer', { channel, timeoutMs: 15000 });
  const calc = logos.module(MODULE_NAME);
  calc.saveToken(TOKEN);

  try {
    // async call, scalar result
    const sum = await calc.call('add', 5, 3);
    assert(sum === 8, `add(5,3) === 8, got ${JSON.stringify(sum)}`);
    console.log('OK  add(5,3) =', sum);

    // async call, object result (a QVariantMap on the far side)
    const g = await calc.call('greet', 'world');
    assert(g && g.message === 'hello world', `greet, got ${JSON.stringify(g)}`);
    console.log('OK  greet("world") =', JSON.stringify(g));

    // {_bytes} round trip. Encoded by THIS SDK, decoded and re-encoded by the
    // C++ codec, decoded again here: the two base64url implementations have to
    // agree byte for byte, including the bytes that differ between base64 and
    // base64url (0xfb/0xff produce '-' and '_').
    const payload = new Uint8Array([0, 1, 251, 255, 72, 105, 62, 63]);
    const echoed = await calc.call('echoBytes', sdk.bytes(payload));
    assert(sdk.isTaggedBytes(echoed), `echoBytes returned tagged bytes, got ${JSON.stringify(echoed)}`);
    const decoded = sdk.fromBytes(echoed);
    assert(decoded.length === payload.length && decoded.every((b, i) => b === payload[i]),
      `bytes round trip, got ${JSON.stringify(Array.from(decoded))}`);
    console.log('OK  echoBytes =', JSON.stringify(echoed));

    // introspection: ModuleProxy::getPluginMethods() over the wire
    const iface = await calc.getMethods();
    const names = iface.map((m) => m.name);
    assert(names.includes('add') && names.includes('echoBytes'),
      `getMethods includes the C++ methods, got ${JSON.stringify(names)}`);
    console.log('OK  getMethods =', JSON.stringify(names));

    // event: the shim emits `ticked` on a QTimer; the Subscribe has to reach it
    // first, which is exactly what waiting for the first delivery proves.
    const seen = [];
    const off = calc.on('ticked', (n) => seen.push(n));
    await waitFor(() => seen.length > 0, 5000, 'a ticked event from the C++ provider');
    assert(typeof seen[0] === 'number' && seen[0] > 0, `ticked payload, got ${JSON.stringify(seen)}`);
    console.log('OK  event ticked =', seen[0]);
    off();

    // (c) a typed client generated from calc.lidl, driving the bundled consumer.
    const { parseFile } = require('../codegen/lidl.js');
    const { generateWebClient } = require('../codegen/jsgen.js');
    const mod = parseFile(path.join(__dirname, 'calc.lidl'));
    const genPath = path.join(os.tmpdir(), `calc_web_client_${process.pid}.mjs`);
    fs.writeFileSync(genPath, generateWebClient(mod, {
      sdkImport: path.join(BUNDLE_DIR, 'logos-web.mjs'),
    }));
    const { CalcJsClient } = await import(`file://${genPath}`);
    const typed = CalcJsClient.bind(logos, MODULE_NAME);   // the C++ module, same contract
    const tsum = await typed.add(20, 22);
    assert(tsum === 42, `generated client add(20,22) === 42, got ${JSON.stringify(tsum)}`);
    const tgreet = await typed.greet('codegen');
    assert(tgreet && tgreet.message === 'hello codegen', `generated greet, got ${JSON.stringify(tgreet)}`);
    const tnames = (await typed.getMethods()).map((m) => m.name);
    assert(tnames.includes('add'), `generated getMethods, got ${JSON.stringify(tnames)}`);
    fs.unlinkSync(genPath);
    console.log('OK  generated browser client add(20,22) =', tsum, '| greet =', JSON.stringify(tgreet));

    // The ESM bundle is a real module, not just a file we generated an import
    // for: load it and check it carries the same API as the IIFE one.
    const esm = await import(`file://${path.join(BUNDLE_DIR, 'logos-web.mjs')}`);
    assert(typeof esm.WebClient === 'function' && typeof esm.WebProvider === 'function',
      'the ESM bundle exports WebClient and WebProvider');
    console.log('OK  ESM bundle exports', Object.keys(esm).sort().join(', '));

    console.log('\n=== WEB BUNDLE E2E PASSED ===');
  } finally {
    logos.destroy();
    child.kill('SIGTERM');
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\nWEB BUNDLE E2E FAILED:', (e && e.stack) || e);
  process.exit(1);
});
