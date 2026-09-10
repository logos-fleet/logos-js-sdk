'use strict';
// -----------------------------------------------------------------------------
// WebPeer - everything an RPC conversation is once you take the socket out.
//
// The JS twin of logos::plain::RpcPeer, and it exists for the same reason that
// class does: the hard part of this protocol is not bytes but BOOKKEEPING --
// which pending call a Result belongs to, which of several local handles one
// Event copy fans out to, when an Unsubscribe may go on the wire, and what
// happens to a caller whose channel dies while it waits. A consumer and a
// provider are the same conversation seen from opposite ends, so both halves of
// the browser SDK are this one class plus a handler.
//
// The peer owns NO policy: it does not know what a module is, does not
// interpret a result, and does not decide who may call. It moves messages and
// keeps the registries straight.
// -----------------------------------------------------------------------------
const { MessageType, encodeMessage, decodeMessage } = require('./wire.js');

const DEFAULT_TIMEOUT_MS = 30000;

/** A call that came back !ok, timed out, or could not be sent at all. */
class CallError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CallError';
    this.code = code || 'CALL_FAILED';
  }
}

class WebPeer {
  /**
   * @param {Object} channel  see channel.js
   * @param {Object} [handler] inbound requests (the provider side):
   *        onCall(msg, reply), onMethods(msg, reply), onSubscribe(msg),
   *        onUnsubscribe(msg), onToken(msg), onEvent(msg), onClosed(reason),
   *        onError(err)
   */
  constructor(channel, handler = {}) {
    if (!channel) throw new Error('WebPeer: a channel is required');
    this.channel = channel;
    this.handler = handler;
    this._nextId = 1;
    this._nextSubId = 1;
    this._pending = new Map();         // call id -> {resolve, reject, timer}
    this._pendingMethods = new Map();  // methods id -> {resolve, reject, timer}
    this._subs = new Map();            // key -> {object, event, handles:[{id, callback}]}
    this._subKeys = new Map();         // subscription id -> key
    this._stopped = false;
  }

  isOpen() { return !this._stopped && this.channel.isOpen(); }

  start() {
    if (!this._stopped) this.channel.setReceiver((text) => this._receive(text));
    return this;
  }

  nextId() { return this._nextId++; }

  // -- outbound ---------------------------------------------------------------

  /** Send a Call and resolve with its ResultMessage (ok or not - see consumer.js). */
  sendCall(msg, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return this._request(MessageType.Call, this._pending, msg,
      `call ${msg.object}.${msg.method}`, timeoutMs);
  }

  /** Send a Methods query and resolve with its MethodsResultMessage. */
  sendMethods(msg, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return this._request(MessageType.Methods, this._pendingMethods, msg,
      `methods query for ${msg.object}`, timeoutMs);
  }

  // A request/response exchange: register the waiter in `pending` under a
  // fresh id, put the message on the wire, and settle when the reply lands
  // (_dispatch), the deadline passes, or the send itself fails.
  _request(type, pending, msg, what, timeoutMs) {
    const id = this.nextId();
    return new Promise((resolve, reject) => {
      if (!this.isOpen()) { reject(new CallError('channel is closed', 'TRANSPORT_ERROR')); return; }
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CallError(`${what} timed out after ${timeoutMs}ms`, 'TIMEOUT'));
      }, timeoutMs);
      // Unref where the host allows it: a pending call must not be the reason a
      // Node process stays alive after its caller gave up.
      if (timer && typeof timer.unref === 'function') timer.unref();
      pending.set(id, { resolve, reject, timer });
      try {
        this._emit({ ...msg, type, id });
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      }
    });
  }

  /**
   * Send a Call and BLOCK until its Result arrives. Requires a channel with
   * receiveSync (see channel.js). Every other message drained while waiting is
   * dispatched normally, so an event that overtakes the reply is not lost.
   */
  sendCallSync(msg, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (typeof this.channel.receiveSync !== 'function') {
      throw new CallError(
        'this channel cannot round-trip synchronously: callSync needs a channel ' +
        'with receiveSync (a worker_threads port in Node, a SharedArrayBuffer ' +
        'pump in a Web Worker). Use call() instead.', 'UNSUPPORTED');
    }
    if (!this.isOpen()) throw new CallError('channel is closed', 'TRANSPORT_ERROR');

    const id = this.nextId();
    let answer = null;
    // Registered in the SAME map the async path uses, and before the send, so a
    // reply that arrives through the ordinary receiver instead of through
    // receiveSync still lands, and a reply can never overtake its registration.
    this._pending.set(id, {
      resolve: (res) => { answer = { res }; },
      reject: (err) => { answer = { err }; },
      timer: null,
    });
    this._emit({ ...msg, type: MessageType.Call, id });

    const deadline = Date.now() + timeoutMs;
    while (answer === null) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const text = this.channel.receiveSync(remaining);
      if (text === null || text === undefined) continue;
      this._receive(text);
    }
    this._pending.delete(id);
    if (answer === null)
      throw new CallError(`call ${msg.object}.${msg.method} timed out after ${timeoutMs}ms`, 'TIMEOUT');
    if (answer.err) throw answer.err;
    return answer.res;
  }

  /**
   * Register interest in (object, event) and return a subscription id.
   *
   * A LIST per key, in registration order, because several handles on this one
   * channel legitimately want the same event and the far end sends ONE copy per
   * connection - so the fan-out to local handles happens here. Only the FIRST
   * handle puts a Subscribe on the wire and only the last withdrawal puts an
   * Unsubscribe there, which is what keeps one handle's teardown from silencing
   * another's.
   */
  sendSubscribe(object, event, callback) {
    const key = subKey(object, event);
    const id = this._nextSubId++;
    let entry = this._subs.get(key);
    const first = !entry;
    if (!entry) { entry = { object, event: event || '', handles: [] }; this._subs.set(key, entry); }
    entry.handles.push({ id, callback });
    this._subKeys.set(id, key);
    if (first) this._emit({ type: MessageType.Subscribe, object, event: event || '' });
    return id;
  }

  sendUnsubscribe(id) {
    const key = this._subKeys.get(id);
    if (key === undefined) return;
    this._subKeys.delete(id);
    const entry = this._subs.get(key);
    if (!entry) return;
    entry.handles = entry.handles.filter((h) => h.id !== id);
    if (entry.handles.length > 0) return;
    this._subs.delete(key);
    if (this.isOpen())
      this._emit({ type: MessageType.Unsubscribe, object: entry.object, event: entry.event });
  }

  sendEvent(msg) { this._emit({ ...msg, type: MessageType.Event }); }
  sendToken(msg) { this._emit({ ...msg, type: MessageType.Token }); }
  sendResult(msg) { this._emit({ ...msg, type: MessageType.Result }); }
  sendMethodsResult(msg) { this._emit({ ...msg, type: MessageType.MethodsResult }); }

  /**
   * Answer every pending caller with a transport error, drop the
   * subscriptions, close the channel and tell the handler this peer is gone.
   * Idempotent - only the first caller does anything.
   */
  stop(reason = 'stopped') {
    if (this._stopped) return;
    this._stopped = true;
    for (const pending of [this._pending, this._pendingMethods]) {
      for (const p of pending.values()) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new CallError(`channel closed: ${reason}`, 'TRANSPORT_ERROR'));
      }
      pending.clear();
    }
    this._subs.clear();
    this._subKeys.clear();
    try { this.channel.setReceiver(null); } catch { /* already detached */ }
    try { this.channel.close(); } catch { /* already closed */ }
    if (this.handler.onClosed) { try { this.handler.onClosed(reason); } catch { /* handler */ } }
  }

  // -- inbound ----------------------------------------------------------------

  _emit(msg) {
    const text = encodeMessage(msg);
    if (!this.channel.send(text))
      throw new CallError('channel refused the message (closed)', 'TRANSPORT_ERROR');
  }

  _receive(text) {
    let msg;
    try {
      msg = decodeMessage(text);
    } catch (e) {
      // A malformed message is the PEER's fault and must not take this side
      // down: report it and keep serving the conversation.
      this._report(e);
      return;
    }
    try { this._dispatch(msg); } catch (e) { this._report(e); }
  }

  _report(err) {
    if (this.handler.onError) { try { this.handler.onError(err); } catch { /* handler */ } }
  }

  _dispatch(msg) {
    const h = this.handler;
    switch (msg.type) {
      case MessageType.Result:
      case MessageType.MethodsResult: {
        const pending = msg.type === MessageType.Result ? this._pending : this._pendingMethods;
        const p = pending.get(msg.id);
        if (!p) return;                        // a reply to a call we gave up on
        pending.delete(msg.id);
        if (p.timer) clearTimeout(p.timer);
        p.resolve(msg);
        return;
      }
      case MessageType.Event: {
        // One copy arrived; every local handle that asked for it gets called -
        // named subscribers and wildcard ("") subscribers alike.
        const named = this._subs.get(subKey(msg.object, msg.event));
        const wild = msg.event ? this._subs.get(subKey(msg.object, '')) : undefined;
        const handles = [...(named ? named.handles : []), ...(wild ? wild.handles : [])];
        for (const handle of handles) {
          try { handle.callback(msg); } catch (e) { this._report(e); }
        }
        if (h.onEvent) h.onEvent(msg);
        return;
      }
      case MessageType.Call:
        if (h.onCall) h.onCall(msg, (res) => { if (this.isOpen()) this.sendResult({ ...res, id: msg.id }); });
        else this.sendResult({ id: msg.id, ok: false, err: 'this peer serves no objects', errCode: 'MODULE_NOT_LOADED' });
        return;
      case MessageType.Methods:
        if (h.onMethods) h.onMethods(msg, (res) => { if (this.isOpen()) this.sendMethodsResult({ ...res, id: msg.id }); });
        else this.sendMethodsResult({ id: msg.id, ok: false, err: 'this peer serves no objects' });
        return;
      case MessageType.Subscribe:
        if (h.onSubscribe) h.onSubscribe(msg);
        return;
      case MessageType.Unsubscribe:
        if (h.onUnsubscribe) h.onUnsubscribe(msg);
        return;
      case MessageType.Token:
        if (h.onToken) h.onToken(msg);
        return;
      default:
        return;
    }
  }
}

// The registry key. Built with a separator that cannot occur in either half of
// a real (object, event) pair, and never split back apart - the pair is stored
// alongside the handles instead.
const subKey = (object, event) => object + '\u0000' + (event || '');

module.exports = { WebPeer, CallError, DEFAULT_TIMEOUT_MS };
