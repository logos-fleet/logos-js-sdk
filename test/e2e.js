'use strict';
// End-to-end test of the protocol-native SDK: a Node PROVIDER (child process)
// and a Node CONSUMER (this process) exchange calls + events over plain TCP,
// with no liblogos_core and no Qt event loop anywhere.
const path = require('path');
const { LogosClient, tcp, protocolVersion } = require('..');
const { assert, spawnReady } = require('./helpers.js');

const PORT = Number(process.env.LOGOS_E2E_PORT || (6100 + (process.pid % 800)));

async function main() {
  console.log('logos-protocol', protocolVersion());

  // The provider child gets its OWN liblogos_protocol when LOGOS_E2E_PROVIDER_LIB
  // is set. The two halves of this SDK have different upstream requirements —
  // the consumer needs only the merged shared library (logos-protocol#4), the
  // provider needs the C ABI to actually serve (logos-protocol#12, still open) —
  // so being able to run each half against a DIFFERENT protocol build is what
  // lets you attribute a failure to a half instead of to "the protocol".
  //
  //   LOGOS_PROTOCOL_LIB=<protocol master>  \
  //   LOGOS_E2E_PROVIDER_LIB=<provider-capable protocol>  node test/e2e.js
  //
  // exercises the consumer against master. Unset, both halves share one build
  // and this is an ordinary single-protocol e2e.
  const providerLib = process.env.LOGOS_E2E_PROVIDER_LIB;
  if (providerLib) console.log('provider child protocol lib:', providerLib);

  const { child: prov, ready } = spawnReady(process.execPath, [path.join(__dirname, 'provider-fixture.js')], {
    env: {
      ...process.env,
      LOGOS_E2E_PORT: String(PORT),
      ...(providerLib ? { LOGOS_PROTOCOL_LIB: providerLib } : {}),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
    stream: 'stdout', timeoutMs: 10000, what: 'the provider',
  });
  await ready;

  const logos = new LogosClient('e2e_app', { transport: tcp('127.0.0.1', PORT) });
  logos.saveToken('calc_js', 'e2e-tok'); // pre-seed so no capability handshake
  const calc = logos.module('calc_js');

  try {
    // (1) async call → Promise, scalar result
    const sum = await calc.call('add', 5, 3);
    assert(sum === 8, `add(5,3) === 8, got ${JSON.stringify(sum)}`);
    console.log('OK  add(5,3) =', sum);

    // (2) async call, object result
    const g = await calc.call('greet', 'world');
    assert(g && g.message === 'hello world', `greet, got ${JSON.stringify(g)}`);
    console.log('OK  greet("world") =', JSON.stringify(g));

    // (3) bytes round-trip ({_bytes: base64url} survives the JSON wire)
    const bytesVal = { _bytes: Buffer.from('hi').toString('base64url') };
    const back = await calc.call('echoBytes', bytesVal);
    assert(back && back._bytes === bytesVal._bytes, `bytes round-trip, got ${JSON.stringify(back)}`);
    console.log('OK  echoBytes =', JSON.stringify(back));

    // (4) introspection
    const methods = calc.getMethods().map((m) => m.name);
    assert(methods.includes('add'), `getMethods includes add, got ${JSON.stringify(methods)}`);
    console.log('OK  getMethods =', JSON.stringify(methods));

    // (5) event subscription
    const tick = await new Promise((resolve) => {
      const off = calc.on('ticked', (v) => { off(); resolve(v); });
      setTimeout(() => resolve(null), 3000);
    });
    assert(typeof tick === 'number' && tick > 0, `ticked event, got ${JSON.stringify(tick)}`);
    console.log('OK  event ticked =', tick);

    // (6) sync call path
    const sum2 = calc.callSync('add', 40, 2);
    assert(sum2 === 42, `callSync add(40,2) === 42, got ${JSON.stringify(sum2)}`);
    console.log('OK  callSync add(40,2) =', sum2);

    // (7) codegen round-trip: generate a typed client from calc.lidl and call
    // the SAME live provider through it (needs the shared logos-lidl lib).
    if (process.env.LOGOS_LIDL_LIB || process.env.LOGOS_LIDL_ROOT) {
      const { parseFile } = require('../codegen/lidl.js');
      const { generateClient } = require('../codegen/jsgen.js');
      const genPath = path.join(require('os').tmpdir(), `calc_client_${process.pid}.js`);
      require('fs').writeFileSync(genPath, generateClient(parseFile(path.join(__dirname, 'calc.lidl'))));
      const { CalcJsClient } = require(genPath);
      const typed = CalcJsClient.bind(logos);            // typed wrapper over the proxy
      const tsum = await typed.add(20, 22);
      assert(tsum === 42, `generated client add(20,22) === 42, got ${JSON.stringify(tsum)}`);
      const tgen = await typed.greet('codegen');
      assert(tgen && tgen.message === 'hello codegen', `generated greet, got ${JSON.stringify(tgen)}`);
      require('fs').unlinkSync(genPath);
      console.log('OK  codegen client add(20,22) =', tsum, '| greet =', JSON.stringify(tgen));
    } else {
      console.log('..  codegen round-trip skipped (set LOGOS_LIDL_LIB to enable)');
    }

    console.log('\n=== E2E PASSED ===');
  } finally {
    logos.destroy();
    prov.kill('SIGTERM');
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('\nE2E FAILED:', e.message); process.exit(1); });
