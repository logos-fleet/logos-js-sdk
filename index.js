'use strict';
// =============================================================================
// logos-js-sdk — a protocol-native JavaScript SDK for Logos.
//
// A thin, Qt-free wrapper over the logos-protocol lp_* C ABI (via koffi). A
// Node process is an out-of-process CONSUMER (LogosClient) and/or PROVIDER
// (Provider) over a PLAIN transport — plain TCP, TCP+SSL, or a plain-local Unix
// socket. There is no embedded Qt host and no Qt event loop.
//
//   const { LogosClient, Provider, tcp, unixSocket } = require('logos-js-sdk');
//
//   // consume
//   const logos = new LogosClient('my_app', { transport: tcp('127.0.0.1', 6001) });
//   const sum   = await logos.module('calc_module').call('add', 5, 3);
//
//   // provide
//   const p = new Provider('greeter', tcp('127.0.0.1', 6002));
//   p.register({ handlers: { hello: (name) => `hi ${name}` }, events: ['greeted'] });
//   p.emit('greeted', 'world');
// =============================================================================
const ffi = require('./src/ffi.js');
const { LogosClient, ModuleProxy } = require('./src/client.js');
const { Provider } = require('./src/provider.js');
// The message shapes, re-exported from the browser build (src/web/wire.js).
// Nothing in this half encodes a message itself -- the C library does -- but a
// Node process that RELAYS them does: the Web container's native bridge moves
// frames between a webview's channel and the core without interpreting them,
// and a `{_bytes}` value has to be validated at that edge. It reads the shapes
// from the same file the browser build is written against, so there is one
// definition of the wire in this package and not two.
const wire = require('./src/web/wire.js');

// ── transport config helpers ────────────────────────────────────────────────
/** Plain TCP transport. */
function tcp(host = '127.0.0.1', port = 0, codec = 'json') {
  return { protocol: 'tcp', host, port, codec };
}
/** Plain TCP + TLS transport. */
function tcpSsl(host, port, { caFile, certFile, keyFile, verifyPeer = true, codec = 'json' } = {}) {
  const t = { protocol: 'tcp_ssl', host, port, codec, verify_peer: verifyPeer };
  if (caFile) t.ca_file = caFile;
  if (certFile) t.cert_file = certFile;
  if (keyFile) t.key_file = keyFile;
  return t;
}
/** Plain-local Unix-domain socket transport (the Qt-free local path). */
function unixSocket(socketPath, codec = 'json') {
  return { protocol: 'plain_local', socket_path: socketPath, codec };
}

// ── protocol version / mode ─────────────────────────────────────────────────
function protocolVersion(libPath) {
  return ffi.load(libPath).lp_protocol_version();
}
function protocolAbiMajor(libPath) {
  return ffi.load(libPath).lp_protocol_abi_major();
}
/** Set the process mode ('remote' | 'local' | 'mock'). Plain transports need
 *  'remote' (the default). */
function setMode(mode, libPath) {
  return ffi.load(libPath).lp_set_mode(mode) === ffi.LP_OK;
}

module.exports = {
  LogosClient, ModuleProxy, Provider,
  tcp, tcpSsl, unixSocket,
  protocolVersion, protocolAbiMajor, setMode,
  // The browser build lives behind the `logos-js-sdk/web` subpath export; only
  // the shapes it shares with this half are re-exported here.
  wire,
};
