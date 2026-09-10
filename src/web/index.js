'use strict';
// =============================================================================
// logos-js-sdk/web - the BROWSER build of the Logos SDK.
//
// The lp_* consumer and provider semantics, in JavaScript, over a MessagePort-
// shaped channel. This is what an HTML/JS module inside the Web container uses,
// and what the Wasm host's glue calls; there is no koffi, no native library and
// no Node builtin below this line, so the whole thing bundles for a browser.
//
//   import { WebClient, WebProvider, messagePortChannel } from 'logos-js-sdk/web';
//
//   // consume a module published on the web transport
//   const logos = new WebClient('my_web_module', {
//     channel: messagePortChannel(portToTheHost),
//   });
//   const calc = logos.module('calc_module');
//   calc.saveToken('web-token');
//   const sum = await calc.call('add', 5, 3);
//
//   // serve one
//   const p = new WebProvider('calc_js', { channel: messagePortChannel(port) });
//   p.register({ handlers: { add: (a, b) => a + b }, events: ['ticked'] });
//   p.emit('ticked', 1);
//
//   // BE ONE: a page inside the Web container serves its module and calls back
//   // out on the SAME channel, so the client borrows the provider's peer. Two
//   // peers over one channel would fight over its single receiver.
//   const peer  = provider.attach(await window.logosChannelReady);
//   const logos = new WebClient('my_module', { peer });
//   const token = await logos.module('capability_module')
//                           .call('requestModule', 'other_module');
//
// The wire is logos-protocol's WEB transport (cpp/implementations/web): the
// plain transport's message set as JSON over a channel, with no byte framing.
// The shapes live in wire.js, which the Node half of this SDK re-exports too -
// one definition, so the two builds cannot drift.
// =============================================================================
const wire = require('./wire.js');
const { WebPeer, CallError, DEFAULT_TIMEOUT_MS } = require('./peer.js');
const { WebClient, WebModuleProxy } = require('./consumer.js');
const { WebProvider } = require('./provider.js');
const { messageChannelPair, messagePortChannel, canReceiveSync } = require('./channel.js');

module.exports = {
  // consumer / provider
  WebClient, WebModuleProxy, WebProvider,
  // the conversation, for hosts that need it directly (the Wasm host's glue)
  WebPeer, CallError, DEFAULT_TIMEOUT_MS,
  // channels
  messagePortChannel, messageChannelPair, canReceiveSync,
  // the shared message shapes
  wire,
  MessageType: wire.MessageType,
  MAX_FRAME_LENGTH: wire.MAX_FRAME_LENGTH,
  FramingError: wire.FramingError,
  CodecError: wire.CodecError,
  bytes: wire.bytes,
  fromBytes: wire.fromBytes,
  isTaggedBytes: wire.isTaggedBytes,
};
