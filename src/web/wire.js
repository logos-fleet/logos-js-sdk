'use strict';
// -----------------------------------------------------------------------------
// The message shapes — THE ONE PLACE either half of this SDK says what a Logos
// protocol message looks like.
//
// The browser build speaks these shapes over a message channel; the Node build
// stays on koffi and lets the C library speak them over a socket. They are the
// same shapes either way, and this module is dependency-free (no koffi, no Node
// builtins, no DOM) precisely so both halves can require it — see index.js,
// which re-exports it as `wire`.
//
// The wire is the WEB transport's (logos-protocol cpp/implementations/web):
//
//     plain wire : [4-byte length][1-byte type tag][payload bytes]
//     web wire   : {"type": <tag>, "payload": <the same payload>}
//
// Same tag numbers, same payload field names, same `{"_bytes": "<base64url>"}`
// for bytes, and the SAME size cap. A transport that dropped the cap because it
// has no length prefix would simply be the way around it.
// -----------------------------------------------------------------------------

// The tag numbers are on the wire — logos::plain::MessageType. Keep them stable.
const MessageType = {
  Call: 1,
  Result: 2,
  Subscribe: 3,
  Unsubscribe: 4,
  Event: 5,
  Token: 6,
  Methods: 7,
  MethodsResult: 8,
};

// logos::plain::kMaxFrameLength. Accounted exactly as encodeFrame() does: one
// tag byte plus the payload, where "the payload" is the envelope text's UTF-8
// length.
const MAX_FRAME_LENGTH = 16 * 1024 * 1024;

/** The peer sent something too big, or we were asked to. logos::plain::FramingError. */
class FramingError extends Error {
  constructor(message) { super(message); this.name = 'FramingError'; }
}
/** The bytes are not a well-formed message. logos::plain::CodecError. */
class CodecError extends Error {
  constructor(message) { super(message); this.name = 'CodecError'; }
}

// ── size accounting ─────────────────────────────────────────────────────────
// The cap is in BYTES and a JS string is UTF-16, so the honest measure is the
// UTF-8 length. Encoding the whole string just to count it would double the
// allocation this cap exists to bound, so take the cheap upper bound first: one
// UTF-16 code unit is at most 3 UTF-8 bytes (a surrogate PAIR is 4 bytes for
// 2 units), and only walk the string when that bound cannot settle it.
function utf8Length(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length
             && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      n += 4; i++;
    } else n += 3;
  }
  return n;
}

function exceedsCap(text) {
  if (1 + text.length * 3 <= MAX_FRAME_LENGTH) return false;
  return 1 + utf8Length(text) > MAX_FRAME_LENGTH;
}

// ── bytes ⇄ {_bytes: base64url} ─────────────────────────────────────────────
// JSON has no bytes primitive, so bytes round-trip through a tagged object.
// Unpadded base64url with the RFC 4648 §5 alphabet — logos::b64UrlEncode.
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
// Reverse lookup by char code; -1 marks a character outside the alphabet.
const B64URL_VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < B64URL.length; i++) B64URL_VALUE[B64URL.charCodeAt(i)] = i;

function b64UrlEncode(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  let i = 0;
  for (; i + 3 <= u8.length; i += 3) {
    const n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  if (i < u8.length) {
    let n = u8[i] << 16;
    if (i + 1 < u8.length) n |= u8[i + 1] << 8;
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
    if (i + 1 < u8.length) out += B64URL[(n >> 6) & 63];
  }
  return out;
}

// The rules of logos::b64UrlDecodeChecked: trailing '=' tolerated (we never
// emit it), a length ≡ 1 (mod 4) body rejected, any character outside the
// alphabet rejected. Both functions below apply them; the second one also
// decodes. Each returns null instead of throwing so callers can decide.
function b64UrlBody(text) {
  if (typeof text !== 'string') return null;
  let end = text.length;
  while (end > 0 && text[end - 1] === '=') end--;
  if (end % 4 === 1) return null;
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128 || B64URL_VALUE[c] < 0) return null;
  }
  return text.slice(0, end);
}

/** True when `text` is well-formed base64url. No allocation beyond the scan. */
function b64UrlValid(text) { return b64UrlBody(text) !== null; }

function b64UrlDecodeChecked(text) {
  const body = b64UrlBody(text);
  if (body === null) return null;
  const out = new Uint8Array((body.length * 3) >> 2);
  let buf = 0, bits = 0, n = 0;
  for (let i = 0; i < body.length; i++) {
    buf = (buf << 6) | B64URL_VALUE[body.charCodeAt(i)];
    bits += 6;
    if (bits >= 8) { bits -= 8; out[n++] = (buf >> bits) & 0xff; }
  }
  return out.subarray(0, n);
}

/** The canonical tagged-bytes form: EXACTLY one key, "_bytes", holding a string. */
function isTaggedBytes(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
      && typeof v._bytes === 'string' && Object.keys(v).length === 1;
}
/** Wrap a Uint8Array (or array of byte values) as a wire bytes value. */
function bytes(value) { return { _bytes: b64UrlEncode(value) }; }
/** Unwrap a wire bytes value to a Uint8Array. Throws CodecError if malformed. */
function fromBytes(value) {
  if (!isTaggedBytes(value)) throw new CodecError('not a tagged bytes value');
  const out = b64UrlDecodeChecked(value._bytes);
  if (out === null) throw new CodecError('invalid base64url input');
  return out;
}

// VALIDATED AT THE EDGE, on the way in, exactly where the C++ codec validates
// it: a `{_bytes}` whose payload is not base64url is a malformed message, not a
// map that happens to have a "_bytes" key, and finding that out three layers
// later inside a handler is how a decoding bug becomes an application bug.
function validateValue(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) { for (const e of v) validateValue(e); return v; }
  if (isTaggedBytes(v)) {
    if (!b64UrlValid(v._bytes)) throw new CodecError('invalid base64url input');
    return v;
  }
  for (const k of Object.keys(v)) validateValue(v[k]);
  return v;
}

// ── message ⇄ payload ───────────────────────────────────────────────────────
// Field names and defaults mirror json_mapping.cpp one for one, including which
// fields a message OMITS: a Result carries `value` when ok and `err`/`errCode`
// when not, and a peer that always sent both would be describing two outcomes.
const str = (v) => (typeof v === 'string' ? v : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const list = (v) => (Array.isArray(v) ? validateValue(v) : []);

function payloadOf(msg) {
  switch (msg.type) {
    case MessageType.Call:
      return { id: msg.id, authToken: msg.authToken || '', object: msg.object,
               method: msg.method, args: msg.args || [] };
    case MessageType.Result:
      return msg.ok
        ? { id: msg.id, ok: true, value: msg.value === undefined ? null : msg.value }
        : { id: msg.id, ok: false, err: msg.err || '', errCode: msg.errCode || '' };
    case MessageType.Subscribe:
    case MessageType.Unsubscribe:
      return { object: msg.object, event: msg.event || '' };
    case MessageType.Event:
      return { object: msg.object, event: msg.event || '', data: msg.data || [] };
    case MessageType.Token:
      return { authToken: msg.authToken || '', moduleName: msg.moduleName || '',
               token: msg.token || '' };
    case MessageType.Methods:
      return { id: msg.id, authToken: msg.authToken || '', object: msg.object };
    case MessageType.MethodsResult:
      return msg.ok
        ? { id: msg.id, ok: true, methods: (msg.methods || []).map(normalizeMethod) }
        : { id: msg.id, ok: false, err: msg.err || '' };
    default:
      throw new CodecError(`unknown message type ${msg.type}`);
  }
}

// One MethodsResult entry, in the shape it has on the wire. The same
// normalisation is applied on the way out and on the way in, so a JS provider
// and a JS consumer agree with the C++ codec and with each other.
function normalizeMethod(m) {
  const o = m && typeof m === 'object' ? m : {};
  return {
    name: str(o.name),
    signature: str(o.signature),
    returnType: str(o.returnType),
    isInvokable: o.isInvokable === undefined ? true : !!o.isInvokable,
    parameters: Array.isArray(o.parameters) ? o.parameters : [],
    // A provider tags each entry "method" or "event" (ModuleProxy's
    // getPluginInterface() does, and its getPluginMethods()/getPluginEvents()
    // are just filters of it). MethodMetadata has no such field, so it rides in
    // the same JSON object the C++ side leaves room for -- dropping it here
    // would make a JS provider's interface unreadable to a consumer that asks
    // "which of these are events?".
    ...(o.type === undefined ? {} : { type: o.type }),
  };
}

function messageFromPayload(type, p) {
  if (p === null || typeof p !== 'object' || Array.isArray(p))
    throw new CodecError('expected a top-level object payload');
  switch (type) {
    case MessageType.Call:
      return { type, id: num(p.id), authToken: str(p.authToken), object: str(p.object),
               method: str(p.method), args: list(p.args) };
    case MessageType.Result: {
      const ok = p.ok === true;
      return ok
        ? { type, id: num(p.id), ok, value: validateValue(p.value === undefined ? null : p.value) }
        : { type, id: num(p.id), ok, err: str(p.err), errCode: str(p.errCode) };
    }
    case MessageType.Subscribe:
    case MessageType.Unsubscribe:
      return { type, object: str(p.object), event: str(p.event) };
    case MessageType.Event:
      return { type, object: str(p.object), event: str(p.event), data: list(p.data) };
    case MessageType.Token:
      return { type, authToken: str(p.authToken), moduleName: str(p.moduleName), token: str(p.token) };
    case MessageType.Methods:
      return { type, id: num(p.id), authToken: str(p.authToken), object: str(p.object) };
    case MessageType.MethodsResult: {
      const ok = p.ok === true;
      return ok
        ? { type, id: num(p.id), ok, methods: (Array.isArray(p.methods) ? p.methods : []).map(normalizeMethod) }
        : { type, id: num(p.id), ok, err: str(p.err) };
    }
    default:
      throw new CodecError('web message carries an unknown type tag');
  }
}

/** One protocol message → one JSON text. Throws FramingError above the cap. */
function encodeMessage(msg) {
  const text = JSON.stringify({ type: msg.type, payload: payloadOf(msg) });
  if (exceedsCap(text)) throw new FramingError('frame too large');
  return text;
}

/** One JSON text → one protocol message. Throws FramingError / CodecError. */
function decodeMessage(text) {
  if (typeof text !== 'string') throw new CodecError('web message is not text');
  // Checked BEFORE the parse, like the C++ codec: the cap exists to stop a
  // hostile peer from making us allocate, and a JSON document is at its largest
  // as a parse tree, not as the text it came from.
  if (exceedsCap(text)) throw new FramingError('frame length exceeds cap');

  let envelope;
  try { envelope = JSON.parse(text); }
  catch (e) { throw new CodecError('web message parse failed: ' + e.message); }

  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)
      || !('type' in envelope) || !('payload' in envelope))
    throw new CodecError('web message is not a {type, payload} envelope');
  if (!Number.isInteger(envelope.type))
    throw new CodecError('web message type tag is not an integer');

  // An unknown tag is rejected by messageFromPayload.
  return messageFromPayload(envelope.type, envelope.payload);
}

module.exports = {
  MessageType, MAX_FRAME_LENGTH,
  FramingError, CodecError,
  encodeMessage, decodeMessage,
  bytes, fromBytes, isTaggedBytes, b64UrlEncode, b64UrlDecodeChecked,
};
