// The ESM face of the browser build.
//
// src/web/*.js is CommonJS, like the rest of this package, and a browser needs
// an ES module. Rather than keep two copies of the SDK in two module systems,
// this file re-exports the CommonJS entry BY NAME: a bundler turning the CJS
// entry into ESM can only emit a default export (it cannot know the names
// statically), so the names are written down here once, where a missing one is
// a visible omission rather than a silent `undefined` at an import site.
import sdk from './index.js';

export const {
  WebClient, WebModuleProxy, WebProvider,
  WebPeer, CallError, DEFAULT_TIMEOUT_MS,
  messagePortChannel, messageChannelPair, canReceiveSync,
  wire, MessageType, MAX_FRAME_LENGTH, FramingError, CodecError,
  bytes, fromBytes, isTaggedBytes,
} = sdk;

export default sdk;
