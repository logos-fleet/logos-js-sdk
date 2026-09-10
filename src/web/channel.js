'use strict';
// -----------------------------------------------------------------------------
// The channel seam — a bidirectional pipe that moves whole MESSAGES.
//
// This is the entire dependency the browser SDK has on its environment, and it
// is the JS side of logos::web::IMessageChannel. Deliberately smaller than a
// socket: no length prefix, no partial reads, no addressing, because every host
// this SDK runs in already delivers discrete messages — a webview's
// postMessage, a MessagePort, a custom-scheme fetch pump, a Wasm host's port.
//
// A channel is an object with:
//
//   send(text) -> boolean       hand one message to the far end; false when closed
//   setReceiver(fn | null)      install/remove the sink for messages from the far end
//   close()                     idempotent; after it, send() fails
//   isOpen() -> boolean
//   receiveSync(deadlineMs)     OPTIONAL — see below
//
// DELIVERY IS ASYNCHRONOUS: send() must not invoke the far end's receiver on the
// calling thread, for the same reason the C++ contract says so — a peer writes
// while holding its own registry lock, and an inline delivery re-enters it.
//
// receiveSync is the SYNCHRONOUS capability, and it is optional because most
// channels cannot have it. A synchronous call has to block the caller until the
// reply arrives, which is only possible where the far end runs on another
// thread AND this thread can drain the channel without turning its event loop:
// a worker_threads port in Node (see node-channel.js), or a SharedArrayBuffer
// pump in a Web Worker. On a browser main thread it is impossible by
// construction — Atomics.wait is forbidden there — so a channel without
// receiveSync makes callSync() throw a clear error rather than deadlock.
// -----------------------------------------------------------------------------

/** True when `channel` can round-trip a call synchronously (callSync works). */
function canReceiveSync(channel) {
  return !!channel && typeof channel.receiveSync === 'function';
}

// ── an in-process pair, for tests and for two JS modules in one page ─────────
//
// Delivery is deferred (queueMicrotask/setTimeout), never inline: the C++
// in-memory channel spends a whole thread on this rule.
function messageChannelPair() {
  const ends = [makeEnd(), makeEnd()];
  ends[0]._peer = ends[1];
  ends[1]._peer = ends[0];
  return ends;
}

const defer = typeof queueMicrotask === 'function'
  ? queueMicrotask
  : (fn) => setTimeout(fn, 0);

function makeEnd() {
  return {
    _peer: null,
    _receiver: null,
    _open: true,
    setReceiver(fn) { this._receiver = fn || null; },
    isOpen() { return this._open; },
    send(text) {
      if (!this._open) return false;
      const peer = this._peer;
      if (!peer || !peer._open) return false;
      defer(() => {
        if (!peer._open || !peer._receiver) return;
        peer._receiver(text);
      });
      return true;
    },
    close() {
      if (!this._open) return;
      this._open = false;
      this._receiver = null;
    },
  };
}

// ── a MessagePort (browser, or a Node worker_threads port) ──────────────────
//
// The port is the channel: whatever handed it over decided who is on the other
// end, which is what makes a Web module's identity STRUCTURAL — the channel a
// message arrived on IS the module that sent it, so a stolen token cannot be
// used to impersonate another module (ADR 0005).
function messagePortChannel(port, { start = true } = {}) {
  let open = true;
  let receiver = null;

  const onMessage = (ev) => {
    if (!open || !receiver) return;
    // A browser MessagePort delivers an Event with .data; a Node
    // worker_threads port delivers the value itself.
    receiver(ev && typeof ev === 'object' && 'data' in ev ? ev.data : ev);
  };

  if (typeof port.addEventListener === 'function') port.addEventListener('message', onMessage);
  else if (typeof port.on === 'function') port.on('message', onMessage);
  else port.onmessage = onMessage;
  // A port obtained from MessageChannel is paused until start() (the browser
  // does this implicitly with onmessage=, not with addEventListener).
  if (start && typeof port.start === 'function') port.start();

  return {
    send(text) {
      if (!open) return false;
      port.postMessage(text);
      return true;
    },
    setReceiver(fn) { receiver = fn || null; },
    isOpen() { return open; },
    close() {
      if (!open) return;
      open = false;
      receiver = null;
      if (typeof port.removeEventListener === 'function') port.removeEventListener('message', onMessage);
      else if (typeof port.off === 'function') port.off('message', onMessage);
      try { if (typeof port.close === 'function') port.close(); } catch { /* already gone */ }
    },
  };
}

module.exports = { messageChannelPair, messagePortChannel, canReceiveSync };
