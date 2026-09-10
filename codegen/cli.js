#!/usr/bin/env node
'use strict';
// logos-lidl-gen-js — generate a typed JS client (default) or provider scaffold
// (--provider) from a `.lidl` module contract.
//
//   logos-lidl-gen-js calc.lidl -o calc_client.js
//   logos-lidl-gen-js calc.lidl --provider -o calc_provider.js
const fs = require('fs');
const { parseFile } = require('./lidl.js');
const { generateClient, generateWebClient, generateProvider } = require('./jsgen.js');

function usage(code) {
  const w = code ? console.error : console.log;
  w('usage: logos-lidl-gen-js <module.lidl> [--provider] [--target node|browser] [--sdk-import <name>] [-o <out.js>]');
  w('  --provider        emit a provider scaffold instead of a consumer client');
  w('  --target <t>      node (default, CommonJS over the koffi SDK) or browser');
  w('                    (an ES module over the browser build, logos-js-sdk/web)');
  w('  --sdk-import <n>   module specifier for `require(...)` in the output (default: logos-js-sdk)');
  w('  -o, --out <file>   write to a file (default: stdout)');
  process.exit(code);
}

function main(argv) {
  const args = argv.slice(2);
  let input = null, provider = false, out = null, sdkImport = null, target = 'node';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--provider') provider = true;
    else if (a === '-o' || a === '--out') out = args[++i];
    else if (a === '--sdk-import') sdkImport = args[++i];
    else if (a === '--target') target = args[++i];
    else if (a === '-h' || a === '--help') usage(0);
    else if (!input) input = a;
    else usage(2);
  }
  if (!input) usage(2);
  if (target !== 'node' && target !== 'browser') {
    console.error(`unknown --target '${target}' (expected node or browser)`);
    process.exit(2);
  }
  // The browser build lives behind its own subpath export, so the default
  // specifier differs per target; an explicit --sdk-import still wins.
  const importName = sdkImport || (target === 'browser' ? 'logos-js-sdk/web' : 'logos-js-sdk');
  if (provider && target === 'browser') {
    // Deliberately absent rather than silently emitting the koffi scaffold: a
    // browser provider is served by WebProvider over a channel the page owns,
    // and a generated file cannot guess where that channel comes from.
    console.error('--provider has no browser target yet: wire WebProvider up by hand (see README).');
    process.exit(2);
  }

  const mod = parseFile(input);
  const code = provider
    ? generateProvider(mod, { sdkImport: importName })
    : (target === 'browser'
        ? generateWebClient(mod, { sdkImport: importName })
        : generateClient(mod, { sdkImport: importName }));
  if (out) { fs.writeFileSync(out, code); console.error(`wrote ${out} (${provider ? 'provider' : target + ' client'} for ${mod.name})`); }
  else process.stdout.write(code);
}

main(process.argv);
