'use strict';
// End-to-end test of the BROWSER build: a JS provider and a JS consumer talking
// to each other over a real MessageChannel, with no native library anywhere.
//
// The case list is the Node SDK's e2e (test/e2e.js), deliberately: the browser
// build is the same semantics over a different wire, so anything the koffi SDK
// can do and this cannot is a hole in the browser build.
//
//   (1) async call, scalar result        (5) event subscription + withdrawal
//   (2) async call, object result        (6) sync call (from a worker thread)
//   (3) {_bytes} round trip              (7) the frame cap
//   (4) introspection                    (8) an unauthorised call is refused
const { MessageChannel, Worker } = require('node:worker_threads');
const path = require('node:path');
const { WebClient, WebProvider, messagePortChannel, wire } = require('../src/web/index.js');
const { nodePortChannel } = require('../src/web/node-channel.js');

function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, budgetMs, what) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(5);
  }
  throw new Error(`timed out after ${budgetMs}ms waiting for ${what}`);
}

// -- (1)-(5), (7), (8): both ends in this thread, over a real MessageChannel --
async function sameThreadCases() {
  const { port1, port2 } = new MessageChannel();

  const provider = new WebProvider('calc_js', {
    channel: messagePortChannel(port1),
    onError: (e) => { throw e; },
  });
  provider.register({
    handlers: {
      add: (a, b) => a + b,
      greet: (name) => ({ message: `hello ${name}` }),
      echoBytes: (v) => v,               // round-trips a {_bytes} value untouched
      slowSum: async (a, b) => { await sleep(10); return a + b; },
    },
    events: ['ticked'],
  });
  provider.saveToken('web_e2e_app', 'web-e2e-tok');

  const logos = new WebClient('web_e2e_app', { channel: messagePortChannel(port2), timeoutMs: 5000 });
  const calc = logos.module('calc_js');
  calc.saveToken('web-e2e-tok');

  try {
    // (1) async call, scalar result
    const sum = await calc.call('add', 5, 3);
    assert(sum === 8, `add(5,3) === 8, got ${JSON.stringify(sum)}`);
    console.log('OK  add(5,3) =', sum);

    // an async handler answers when it is ready - the channel holds no lock
    const slow = await calc.call('slowSum', 1, 2);
    assert(slow === 3, `slowSum(1,2) === 3, got ${JSON.stringify(slow)}`);
    console.log('OK  slowSum(1,2) =', slow);

    // (2) async call, object result
    const g = await calc.call('greet', 'world');
    assert(g && g.message === 'hello world', `greet, got ${JSON.stringify(g)}`);
    console.log('OK  greet("world") =', JSON.stringify(g));

    // (3) bytes round trip: {_bytes: base64url} survives the JSON wire, and the
    // SDK's own helpers agree with what came back.
    const payload = new Uint8Array([0, 1, 254, 255, 72, 105]);
    const back = await calc.call('echoBytes', wire.bytes(payload));
    assert(wire.isTaggedBytes(back), `echoBytes returned tagged bytes, got ${JSON.stringify(back)}`);
    const decoded = wire.fromBytes(back);
    assert(decoded.length === payload.length && decoded.every((b, i) => b === payload[i]),
      `bytes round trip, got ${JSON.stringify(Array.from(decoded))}`);
    console.log('OK  echoBytes =', JSON.stringify(back));

    // (4) introspection
    const iface = await calc.getMethods();
    const names = iface.map((m) => m.name);
    assert(names.includes('add'), `getMethods includes add, got ${JSON.stringify(names)}`);
    const ticked = iface.find((m) => m.name === 'ticked');
    assert(ticked && ticked.type === 'event', `ticked is tagged an event, got ${JSON.stringify(ticked)}`);
    console.log('OK  getMethods =', JSON.stringify(names));

    // (5) event subscription, then withdrawal. The Subscribe has to REACH the
    // provider before an emission can be expected to find a subscriber.
    const seen = [];
    const off = calc.on('ticked', (n) => seen.push(n));
    await waitFor(() => provider.subscriberCount('ticked') === 1, 2000, 'the Subscribe to arrive');
    provider.emit('ticked', 1);
    await waitFor(() => seen.length === 1, 2000, 'the event to arrive');
    assert(seen[0] === 1, `event payload, got ${JSON.stringify(seen)}`);

    off();
    await waitFor(() => provider.subscriberCount('ticked') === 0, 2000, 'the Unsubscribe to arrive');
    provider.emit('ticked', 2);
    await sleep(50);
    assert(seen.length === 1, `no events after unsubscribe, got ${JSON.stringify(seen)}`);
    console.log('OK  event ticked =', seen[0], '(and silence after unsubscribe)');

    // (7) the frame cap. A message above logos::plain::kMaxFrameLength is
    // refused HERE, before it reaches the channel: a transport with no length
    // prefix that dropped the cap would just be the way around it.
    let framing = null;
    try { await calc.call('echoBytes', 'x'.repeat(wire.MAX_FRAME_LENGTH + 16)); }
    catch (e) { framing = e; }
    assert(framing instanceof wire.FramingError, `oversize call refused with FramingError, got ${framing}`);
    console.log('OK  frame cap refused an oversize call:', framing.message);

    // (8) a call with the wrong token is refused by the provider, with a code
    // the caller can act on.
    calc.saveToken('not-the-token');
    let refused = null;
    try { await calc.call('add', 1, 1); } catch (e) { refused = e; }
    assert(refused && refused.code === 'UNAUTHORIZED', `wrong token refused, got ${refused && refused.code}`);
    calc.saveToken('web-e2e-tok');
    console.log('OK  wrong token refused:', refused.message);
  } finally {
    logos.destroy();
    provider.destroy();
  }
}

// -- (6) sync call, against a provider on another thread ---------------------
async function syncCase() {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(path.join(__dirname, 'web-provider-worker.js'), {
    workerData: { port: port1 },
    transferList: [port1],
  });

  const channel = nodePortChannel(port2);
  const logos = new WebClient('web_e2e_app', { channel, timeoutMs: 5000 });
  const calc = logos.module('calc_js');
  calc.saveToken('web-e2e-tok');

  try {
    // The worker has to be up before a blocking call can be answered: a
    // callSync issued into a thread that has not started yet would block this
    // one for its whole timeout.
    const warm = await calc.call('add', 1, 1);
    assert(warm === 2, `worker provider answers, got ${JSON.stringify(warm)}`);

    const sum = calc.callSync('add', 40, 2);
    assert(sum === 42, `callSync add(40,2) === 42, got ${JSON.stringify(sum)}`);
    console.log('OK  callSync add(40,2) =', sum);

    const g = calc.callSync('greet', 'sync');
    assert(g && g.message === 'hello sync', `callSync greet, got ${JSON.stringify(g)}`);
    console.log('OK  callSync greet("sync") =', JSON.stringify(g));

    // A channel that cannot round-trip synchronously says so instead of
    // deadlocking: that is the browser main thread's case, where Atomics.wait
    // is forbidden outright.
    const { port1: a, port2: b } = new MessageChannel();
    const plain = new WebClient('web_e2e_app', { channel: messagePortChannel(b), timeoutMs: 500 });
    let unsupported = null;
    try { plain.module('calc_js').callSync('add', 1, 1); } catch (e) { unsupported = e; }
    assert(unsupported && unsupported.code === 'UNSUPPORTED',
      `a channel without receiveSync refuses callSync, got ${unsupported && unsupported.code}`);
    plain.destroy();
    a.close();
    console.log('OK  callSync on a plain channel refused:', unsupported.message.slice(0, 60) + '...');
  } finally {
    logos.destroy();
    await worker.terminate();
  }
}

async function main() {
  console.log('=== logos-js-sdk browser build: JS provider <-> JS consumer over a MessageChannel ===\n');
  await sameThreadCases();
  await syncCase();
  console.log('\n=== WEB E2E PASSED ===');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\nWEB E2E FAILED:', e && e.stack || e);
  process.exit(1);
});
