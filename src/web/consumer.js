'use strict';
// -----------------------------------------------------------------------------
// Consumer - call other Logos modules FROM a browser (or any JS host) over a
// message channel.
//
//   const logos = new WebClient('my_web_module', { channel });
//   const calc  = logos.module('calc_module');
//   calc.saveToken('web-token');                       // what we present
//   const sum   = await calc.call('add', 5, 3);        // async (Promise)
//   const off   = calc.on('ticked', (n) => { ... });   // event subscription
//   const meta  = await calc.getMethods();             // introspection
//
// The API is the Node SDK's (src/client.js) with two differences the transport
// forces, both of them visible in the signatures rather than hidden:
//
//   * getMethods() is a PROMISE. Over koffi the introspection call is a
//     blocking FFI call; over a channel it is a Methods/MethodsResult round
//     trip like any other, and pretending otherwise would mean blocking a
//     browser's event loop.
//   * callSync() needs a channel that can round-trip synchronously - see
//     channel.js. On a channel that cannot, it throws instead of deadlocking.
// -----------------------------------------------------------------------------
const { WebPeer, CallError, DEFAULT_TIMEOUT_MS } = require('./peer.js');

class WebModuleProxy {
  constructor(peer, target, client) {
    this._peer = peer;
    this._client = client;
    this.target = target;
    this._token = '';
  }

  /**
   * The auth token this proxy presents on every Call and Methods message.
   *
   * The consumer's OWN copy of the credential, not a store the provider reads:
   * on this transport a call carries its token, and the provider decides. The
   * name mirrors the Node SDK's LogosClient#saveToken, which pre-seeds the same
   * thing in the C library's token store.
   */
  saveToken(token) { this._token = token || ''; return this; }

  /** Async call. Extra args are the positional method arguments. */
  call(method, ...args) {
    return this.callWithTimeout(this._client.timeoutMs, method, ...args);
  }

  async callWithTimeout(timeoutMs, method, ...args) {
    const res = await this._peer.sendCall(
      { object: this.target, method, args, authToken: this._token }, timeoutMs);
    return unwrap(res, this.target, method);
  }

  /**
   * Synchronous call - blocks until the Result arrives. Needs a channel with
   * receiveSync (channel.js); throws CallError('UNSUPPORTED') without one.
   */
  callSync(method, ...args) {
    const res = this._peer.sendCallSync(
      { object: this.target, method, args, authToken: this._token },
      this._client.timeoutMs);
    return unwrap(res, this.target, method);
  }

  /**
   * Subscribe to an event. `handler` receives the event payload as positional
   * args. An empty event name subscribes to every event on the object.
   * Returns an unsubscribe function.
   */
  on(eventName, handler) {
    if (typeof handler !== 'function')
      throw new TypeError(`${this.target}.on(${eventName}): handler must be a function`);
    const id = this._peer.sendSubscribe(this.target, eventName || '',
      (msg) => handler(...(msg.data || [])));
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this._peer.sendUnsubscribe(id);
    };
  }

  /** The target module's interface: [{name, type, signature, returnType, ...}]. */
  async getMethods(timeoutMs = this._client.timeoutMs) {
    const res = await this._peer.sendMethods(
      { object: this.target, authToken: this._token }, timeoutMs);
    if (!res.ok) throw new CallError(res.err || `methods query for ${this.target} failed`, 'METHODS_FAILED');
    return res.methods;
  }

  /**
   * Register an auth token for `moduleName` with the target module (the
   * Token message; ModuleProxy::informModuleToken on the far side).
   * Fire-and-forget: the wire has no acknowledgement for it.
   */
  informToken(moduleName, token, authToken = this._token) {
    this._peer.sendToken({ authToken, moduleName, token });
    return true;
  }
}

// A Result is a two-outcome message and both outcomes are the peer answering.
// The failure is turned into a CallError carrying the provider's OWN errCode,
// because "MODULE_NOT_LOADED" and "METHOD_FAILED" are different bugs and a
// caller that only sees a string cannot tell them apart.
function unwrap(res, target, method) {
  if (res.ok) return res.value;
  throw new CallError(res.err || `call ${target}.${method} failed`, res.errCode || 'CALL_FAILED');
}

class WebClient {
  /**
   * @param {string} originModule  who we call as (our own module name). The
   *   wire carries no origin field - on this transport a module's identity is
   *   STRUCTURAL, it is the channel the message arrived on (ADR 0005) - so this
   *   is what we call ourselves in Token messages and in diagnostics.
   * @param {Object} opts
   * @param {Object} [opts.channel]    the message channel (channel.js)
   * @param {Object} [opts.peer]       an EXISTING WebPeer to call over, instead
   *   of a channel of our own - see below. Exactly one of channel/peer.
   * @param {number} [opts.timeoutMs]  default call timeout (30s)
   * @param {Function} [opts.onError]  malformed inbound message / handler throw.
   *   Only for a peer of our own: a BORROWED peer already has its owner's.
   * @param {Function} [opts.onClosed] the channel went away. Same caveat.
   */
  constructor(originModule, opts = {}) {
    if (!originModule) throw new Error('WebClient: originModule is required');
    if (!opts.channel && !opts.peer)
      throw new Error('WebClient: opts.channel or opts.peer is required');
    this.origin = originModule;
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this._proxies = new Map();
    // CALLING OVER SOMEBODY ELSE'S PEER IS THE MODULE CASE, not a shortcut.
    //
    // A page that IS a Logos module is served over one channel, the one its
    // host handed it, and calling back out - capability_module for a token,
    // then the module it was granted - has to go down that same channel. A
    // second WebPeer over it would install the channel's single receiver and
    // silently take every message from the provider's. So a module page passes
    // the peer its provider is already running on:
    //
    //   const peer  = provider.attach(channel);
    //   const logos = new WebClient('my_module', { peer });
    //
    // The peer is BORROWED in that case: destroy() leaves it alone, because
    // whoever created it is still serving on it.
    this._ownsPeer = !opts.peer;
    this.peer = opts.peer || new WebPeer(opts.channel, {
      onError: opts.onError || (() => {}),
      onClosed: opts.onClosed || (() => {}),
    }).start();
  }

  /** Get (and cache) a proxy to a target module. */
  module(targetName) {
    let p = this._proxies.get(targetName);
    if (!p) {
      p = new WebModuleProxy(this.peer, targetName, this);
      this._proxies.set(targetName, p);
    }
    return p;
  }

  /** Present `token` on every call to `moduleName`. */
  saveToken(moduleName, token) { this.module(moduleName).saveToken(token); return true; }

  /**
   * Stop the conversation and close the channel - unless the peer was handed
   * in, in which case its owner is still serving on it and only this client's
   * proxies go away.
   */
  destroy() {
    if (this._ownsPeer) this.peer.stop('client destroyed');
    this._proxies.clear();
  }
}

module.exports = { WebClient, WebModuleProxy };
