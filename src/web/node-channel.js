'use strict';
// -----------------------------------------------------------------------------
// Node-side channels. NOT part of the browser build - this file is the only one
// under src/web/ that requires a Node builtin, and nothing in the browser entry
// (index.js) reaches it, so the bundle stays free of `node:` imports.
//
// Two channels live here, and both exist because a browser primitive has a Node
// twin that a test or a native host can drive:
//
//   nodePortChannel      a worker_threads MessagePort that can ALSO round-trip
//                        synchronously, which is what makes callSync testable
//                        without a browser. Same shape as the SharedArrayBuffer
//                        pump a Web Worker would use.
//   newlineStreamChannel one message per line over a pair of Node streams - the
//                        channel SHIM a native host binds when the far side is
//                        a process rather than a page (the C++ web transport on
//                        the other end of a child process's stdio).
// -----------------------------------------------------------------------------
const { receiveMessageOnPort } = require('node:worker_threads');
const { messagePortChannel } = require('./channel.js');

/**
 * A worker_threads MessagePort as a channel, WITH receiveSync.
 *
 * receiveSync drains the port without turning this thread's event loop, so a
 * synchronous call is a real block rather than a spin: Atomics.wait parks the
 * thread between drains. It only makes sense when the far end runs on ANOTHER
 * thread - a port whose peer is in this same thread can never answer while we
 * are blocking it, and callSync would simply burn its timeout.
 */
function nodePortChannel(port) {
  const base = messagePortChannel(port);
  // The parking lot: a shared cell nobody ever notifies, used purely as a
  // sleep with a deadline (setTimeout cannot run while we hold the loop).
  const idle = new Int32Array(new SharedArrayBuffer(4));

  base.receiveSync = (deadlineMs) => {
    const end = Date.now() + Math.max(0, deadlineMs);
    for (;;) {
      if (!base.isOpen()) return null;
      const got = receiveMessageOnPort(port);
      if (got) return got.message;
      const left = end - Date.now();
      if (left <= 0) return null;
      // Short naps rather than one long one: the port has no "message
      // arrived" notification we could wait on, so the deadline is ours to
      // enforce and a nap that outlives it would overshoot.
      Atomics.wait(idle, 0, 0, Math.min(left, 2));
    }
  };
  return base;
}

/**
 * One message per line, over a Node readable/writable pair.
 *
 * The framing is a NEWLINE and that is safe rather than lucky: every message on
 * this wire is a JSON document, and JSON escapes the newlines inside its
 * strings, so a raw '\n' in the text can only be the one we put there.
 *
 * @param {Object} opts
 * @param {stream.Readable} opts.input   messages from the far end
 * @param {stream.Writable} opts.output  messages to the far end
 */
function newlineStreamChannel({ input, output }) {
  let open = true;
  let receiver = null;
  let buffered = '';
  const queue = [];   // messages that arrived before a receiver was installed

  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffered += chunk;
    for (;;) {
      const nl = buffered.indexOf('\n');
      if (nl < 0) break;
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      if (!line) continue;
      if (!open) return;
      if (receiver) receiver(line);
      else queue.push(line);
    }
  });
  input.on('end', () => { open = false; });

  return {
    send(text) {
      if (!open) return false;
      return output.write(text + '\n');
    },
    setReceiver(fn) {
      receiver = fn || null;
      // Deferred, never inline: send() must not be able to reach the far end's
      // receiver on the calling stack, and neither must setReceiver().
      if (receiver && queue.length) {
        const pending = queue.splice(0, queue.length);
        queueMicrotask(() => { for (const line of pending) if (receiver) receiver(line); });
      }
    },
    isOpen() { return open; },
    close() {
      if (!open) return;
      open = false;
      receiver = null;
      try { output.end(); } catch { /* already closed */ }
    },
  };
}

module.exports = { nodePortChannel, newlineStreamChannel };
