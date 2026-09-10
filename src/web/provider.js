'use strict';
// -----------------------------------------------------------------------------
// Provider - serve a Logos module FROM JavaScript over message channels.
//
//   const p = new WebProvider('calc_js');
//   p.register({ handlers: { add: (a, b) => a + b }, events: ['ticked'] });
//   p.saveToken('web_app', 'web-token');   // authorise a caller
//   p.attach(channel);                     // one webview / worker / page
//   p.emit('ticked', 1);
//
// The C++ shape, kept: WebTransportHost is HANDED channels rather than
// listening on one, and one host serves as many as it is given, each its own
// peer. attach() is the whole of "a consumer appeared". That is also what makes
// a Web module's identity structural - the channel a call arrived on IS the
// caller - so this class never tries to work out who is calling from anything
// inside the message.
//
// Method handlers may be synchronous OR return a Promise: unlike the koffi
// provider (whose dispatch blocks the library's I/O thread on our main loop),
// nothing here holds a lock while a handler runs, so the reply is simply sent
// when the value is ready.
// -----------------------------------------------------------------------------
const { WebPeer } = require('./peer.js');

class WebProvider {
  /**
   * @param {string} moduleName        the module name this provider serves as
   * @param {Object} [opts]
   * @param {Object} [opts.channel]    attach one channel immediately
   * @param {Function} [opts.onError]
   */
  constructor(moduleName, opts = {}) {
    if (!moduleName) throw new Error('WebProvider: moduleName is required');
    this.name = moduleName;
    this._onError = opts.onError || (() => {});
    this._handlers = {};
    this._iface = [];
    this._onToken = null;
    this._tokens = new Set();
    this._peers = [];       // {peer, subs:Set("event")}
    this._registered = false;
    if (opts.channel) this.attach(opts.channel);
  }

  /**
   * Register the module's implementation.
   * @param {Object} spec
   * @param {Object<string,Function>} spec.handlers  method name -> (args...) =>
   *        value or Promise. Throwing signals a method failure to the caller.
   * @param {string[]} [spec.events]   event names this module can emit
   * @param {Array}    [spec.methods]  explicit interface array (overrides the
   *        auto-derived one); entries are {name, type:'method'|'event', ...}
   * @param {Function} [spec.onToken]  (moduleName, token) => void, for Token
   *        messages (informModuleToken on the Qt side)
   */
  register(spec = {}) {
    if (this._registered) throw new Error('WebProvider already registered');
    this._handlers = spec.handlers || {};
    this._onToken = spec.onToken || null;
    this._iface = spec.methods || [
      ...Object.entries(this._handlers).map(([name, fn]) => {
        const params = paramNames(fn);
        return {
          name,
          type: 'method',
          signature: `${name}(${params.join(', ')})`,
          returnType: 'any',
          isInvokable: true,
          parameters: params.map((p) => ({ name: p, type: 'any' })),
        };
      }),
      ...(spec.events || []).map((name) => ({
        name, type: 'event', signature: `${name}(...)`, returnType: 'void',
        isInvokable: false, parameters: [],
      })),
    ];
    this._registered = true;
    return this;
  }

  /**
   * Accept `token` as a valid auth token from `fromModule`.
   *
   * WHILE NO TOKEN IS SAVED THE PROVIDER IS OPEN. That is the same posture a
   * freshly constructed ModuleProxy has before a host seeds it, and it is what
   * makes a page that serves a module to its own worker usable without a
   * capability round trip. Save one token and the door shuts: from then on a
   * call must carry a token this provider was given.
   *
   * `fromModule` is accepted for symmetry with the Node provider's saveToken
   * and not consulted: tokens are not scoped per caller here, because on this
   * transport the caller is the channel, not a name inside the message.
   */
  saveToken(fromModule, token) {
    this._tokens.add(String(token));
    return true;
  }

  /** Serve one more consumer over `channel`. Returns the peer. */
  attach(channel) {
    const entry = { peer: null, subs: new Set() };
    entry.peer = new WebPeer(channel, {
      onCall: (msg, reply) => this._onCall(msg, reply),
      onMethods: (msg, reply) => this._onMethods(msg, reply),
      onSubscribe: (msg) => { if (msg.object === this.name) entry.subs.add(msg.event || ''); },
      onUnsubscribe: (msg) => { if (msg.object === this.name) entry.subs.delete(msg.event || ''); },
      onToken: (msg) => {
        if (this._onToken) { try { this._onToken(msg.moduleName, msg.token); } catch (e) { this._onError(e); } }
      },
      onError: this._onError,
      onClosed: () => { this._peers = this._peers.filter((p) => p !== entry); },
    }).start();
    this._peers.push(entry);
    return entry.peer;
  }

  /**
   * Emit an event to every peer that subscribed to it - ONE copy per peer, as
   * on the C++ host, because a peer subscribed both by name and by wildcard has
   * one channel and would otherwise be told twice.
   */
  emit(eventName, ...data) {
    let sent = 0;
    for (const entry of this._peers) {
      if (!entry.peer.isOpen()) continue;
      if (!entry.subs.has(eventName) && !entry.subs.has('')) continue;
      try {
        entry.peer.sendEvent({ object: this.name, event: eventName, data });
        sent++;
      } catch (e) { this._onError(e); }
    }
    return sent;
  }

  /** How many attached peers are subscribed to `eventName` right now. */
  subscriberCount(eventName) {
    return this._peers.filter((e) => e.subs.has(eventName) || e.subs.has('')).length;
  }

  /** Stop serving: every attached peer is torn down and its channel closed. */
  destroy() {
    for (const entry of this._peers.slice()) entry.peer.stop('provider destroyed');
    this._peers = [];
  }

  // -- inbound ----------------------------------------------------------------

  _authorized(authToken) {
    if (this._tokens.size === 0) return true;
    return this._tokens.has(String(authToken || ''));
  }

  _onCall(msg, reply) {
    if (msg.object !== this.name) {
      reply({ ok: false, err: `object not published: ${msg.object}`, errCode: 'MODULE_NOT_LOADED' });
      return;
    }
    if (!this._authorized(msg.authToken)) {
      reply({ ok: false, err: `unauthorized call to ${this.name}.${msg.method}`, errCode: 'UNAUTHORIZED' });
      return;
    }
    const fn = this._handlers[msg.method];
    if (typeof fn !== 'function') {
      reply({ ok: false, err: `unknown method ${this.name}.${msg.method}`, errCode: 'METHOD_FAILED' });
      return;
    }
    const failed = (e) =>
      reply({ ok: false, err: `${this.name}.${msg.method}: ${e && e.message}`, errCode: 'METHOD_FAILED' });
    const succeeded = (v) => reply({ ok: true, value: v === undefined ? null : v });
    let out;
    try {
      out = fn(...(msg.args || []));
    } catch (e) {
      failed(e);
      return;
    }
    // A Promise is answered when it settles; a plain value right now, on this
    // stack, which is what keeps a synchronous handler's reply synchronous.
    if (out && typeof out.then === 'function') out.then(succeeded, failed);
    else succeeded(out);
  }

  // INTROSPECTION IS NOT TOKEN-GATED, and that is the protocol's decision, not
  // a relaxation of it. `LogosObject::getMethods()` -- the only consumer-side
  // entry point there is, on every transport -- takes no auth token, so a
  // conforming consumer has nothing to present here; the reference provider
  // (logos-protocol's WebTransportHost::onMethods) accordingly answers without
  // asking. A gate on this one message would therefore not refuse an attacker,
  // it would refuse EVERY C++ consumer: the Web container's own load verdict is
  // a Methods round trip, so a page that gated it reported itself as "never
  // published a module" the moment its credential arrived and shut the door.
  //
  // What the token still gates is every CALL (_onCall), which is where the
  // authority actually is.
  _onMethods(msg, reply) {
    if (msg.object !== this.name) {
      reply({ ok: false, err: 'object not published' });
      return;
    }
    reply({ ok: true, methods: this._iface });
  }
}

// The declared parameter names of a handler, for the signature it reports to an
// introspecting consumer. Best effort by construction - a rest parameter or a
// default value is not a name - which is why an explicit `methods` array
// overrides it.
function paramNames(fn) {
  const src = String(fn);
  const open = src.indexOf('(');
  if (open < 0) return [];
  const close = src.indexOf(')', open);
  if (close < 0) return [];
  return src.slice(open + 1, close)
    .split(',')
    .map((s) => s.trim().split(/[\s=]/)[0])
    .filter((s) => s && /^[A-Za-z_$][\w$]*$/.test(s));
}

module.exports = { WebProvider };
