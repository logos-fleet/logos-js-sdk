# logos-js-sdk

The Logos JavaScript SDK, in two builds that share one set of message shapes.

**The Node build** is a thin [koffi](https://koffi.dev) wrapper over the
logos-protocol `lp_*` C ABI. A Node process is an out-of-process **consumer**
(`lp_client_*`) and/or **provider** (`lp_provider_*`) over a *plain* transport —
plain TCP, TCP+SSL, or a plain-local Unix socket. There is **no embedded Qt host
and no Qt event loop**. It loads a shared `liblogos_protocol` directly; it does
not use `liblogos_core`.

**The browser build** (`logos-js-sdk/web`) is the same consumer and provider
semantics written in JavaScript, speaking logos-protocol's **web transport** over
a `MessagePort`-shaped channel: no native library, no koffi, no Node builtin. It
is what an HTML/JS module inside the Web container uses, and what the Wasm host's
glue calls.

Both builds describe the same messages, from the same file:
[`src/web/wire.js`](src/web/wire.js) is the one place this package says what a
Logos protocol message looks like — tag numbers, field names, the
`{"_bytes": "<base64url>"}` form and the frame cap. The browser build encodes
with it; the Node build hands its messages to the C library and re-exports the
same module (`require('logos-js-sdk').wire`), for the Node hosts that relay web
frames without interpreting them.

| | Node build | browser build |
|---|---|---|
| entry | `require('logos-js-sdk')` | `import … from 'logos-js-sdk/web'` |
| wire | plain transport (framed, over a socket) | web transport (JSON, over a channel) |
| consumer | `LogosClient` / `ModuleProxy` | `WebClient` / `WebModuleProxy` |
| provider | `Provider` (sync handlers) | `WebProvider` (sync **or** async handlers) |
| dependency | `liblogos_protocol` via koffi | a channel, and nothing else |

## Consume a module

```js
const { LogosClient, tcp } = require('logos-js-sdk');

const logos = new LogosClient('my_app', { transport: tcp('127.0.0.1', 6001) });
const calc  = logos.module('calc_module');

const sum = await calc.call('add', 5, 3);         // async → Promise
const off = calc.on('computed', (v) => { … });    // event subscription (off() to stop)
const iface = calc.getMethods();                   // introspection
```

## Provide a module

```js
const { Provider, tcp } = require('logos-js-sdk');

const p = new Provider('greeter', tcp('127.0.0.1', 6002));
p.register({
  handlers: { hello: (name) => `hi ${name}` },     // synchronous handlers
  events: ['greeted'],
});
p.saveToken('caller_module', authToken);            // authorize a caller
p.emit('greeted', 'world');
```

## The browser build

```js
import { WebClient, WebProvider, messagePortChannel, bytes } from 'logos-js-sdk/web';

// consume a module published on the web transport
const logos = new WebClient('my_web_module', { channel: messagePortChannel(port) });
const calc  = logos.module('calc_module');
calc.saveToken(authToken);                       // presented on every call

const sum   = await calc.call('add', 5, 3);      // async → Promise
const off   = calc.on('ticked', (n) => { … });   // event subscription
const iface = await calc.getMethods();           // introspection (a Promise here)
const back  = await calc.call('echoBytes', bytes(new Uint8Array([1, 2, 3])));

// serve one
const p = new WebProvider('calc_js', { channel: messagePortChannel(otherPort) });
p.register({ handlers: { add: (a, b) => a + b }, events: ['ticked'] });
p.saveToken('my_web_module', authToken);          // authorise a caller
p.emit('ticked', 1);
```

### The channel

The channel is the browser build's *whole* dependency on its environment, and it
is the JS side of `logos::web::IMessageChannel`:

```js
{ send(text) -> boolean, setReceiver(fn|null), close(), isOpen(), receiveSync?(ms) }
```

`messagePortChannel(port)` wraps any `MessagePort` (a page's, a worker's, a Node
`worker_threads` one); `messageChannelPair()` is an in-process pair for tests. A
host with something else to bind — a webview's `postMessage`, a custom-scheme
fetch pump, a child process's stdio — writes those five methods itself. Delivery
must be asynchronous: a channel that delivered inline would re-enter the peer
that is writing to it.

`receiveSync` is optional, and `callSync()` is what needs it. A synchronous call
has to block until the reply arrives, which is only possible where the far end
runs on another thread *and* this thread can drain the channel without turning
its event loop — a `worker_threads` port in Node (`nodePortChannel`, in
`src/web/node-channel.js`), or a `SharedArrayBuffer` pump in a Web Worker. On a
browser main thread it is impossible by construction, so a channel without
`receiveSync` makes `callSync()` throw `CallError('UNSUPPORTED')` rather than
deadlock.

### Building the bundle

```sh
npm run build:web          # needs esbuild on PATH; nix develop provides it
nix build .#web-bundle     # or hermetically
```

produces `dist/logos-web.mjs` (an ES module) and `dist/logos-web.js` (an IIFE
exposing a `LogosWeb` global, for a `<script>` tag and for the Wasm host's glue,
which has no loader). `--platform=browser` is also the gate on the browser build
staying browser code: `src/web/node-channel.js` is the only file under `src/web`
that touches a Node builtin and nothing in the entry reaches it, so a stray
`node:` import fails the bundle instead of shipping.

## Typed bindings from a `.lidl` contract

```sh
logos-lidl-gen-js calc.lidl                    > calc_client.js    # typed consumer client (Node)
logos-lidl-gen-js calc.lidl --target browser   > calc_client.mjs   # typed client for the browser build
logos-lidl-gen-js calc.lidl --provider         > calc_provider.js  # provider scaffold (Node)
```

The generated client wraps each method as `async fn(...) → Promise` and each event
as `on<Event>(handler)`. `--target browser` emits an **ES module** against
`WebModuleProxy` instead of CommonJS against the koffi one, with no runtime
import of its own — it only ever touches the proxy it is handed, so it works
whatever bundle the SDK came from:

```js
import { CalcJsClient } from './calc_client.mjs';
const typed = CalcJsClient.bind(logos);          // logos is a WebClient
await typed.add(20, 22);
```

The provider scaffold gives an impl-class stub and a `serve(transports, impl)`
factory; there is no browser provider scaffold, because a generated file cannot
guess where a page's channel comes from. Codegen reuses logos-lidl's canonical
grammar via its C ABI (no JS re-implementation).

## Finding the native libraries

The SDK loads `liblogos_protocol.{so,dylib}` and (for codegen) `liblogos_lidl_c`.
Point it at them with `LOGOS_PROTOCOL_LIB` / `LOGOS_LIDL_LIB` (explicit paths) or
`LOGOS_PROTOCOL_ROOT` / `LOGOS_LIDL_ROOT` (a prefix with `lib/`), or drop them in
`./lib/`. The Nix dev shell sets these for you:

```sh
nix develop      # exports LOGOS_PROTOCOL_LIB / LOGOS_LIDL_LIB, provides node
npm ci && npm test
```

## Test

### The Node build

`npm test` runs `test/e2e.js`: a Node provider (child process) and a Node
consumer exchange async calls, an object result, a `{_bytes}` round-trip,
introspection, an event, a sync call, and a `.lidl`→JS codegen round-trip — all
over a plain transport with no Qt loop. It also runs hermetically as
`nix flake check` (`checks.<system>.e2e`).

`LOGOS_E2E_PROVIDER_LIB` gives the provider **child** its own
`liblogos_protocol`, so each half can be exercised against a different protocol
build. Because the two halves have different upstream requirements (see below),
this is what attributes a failure to a half rather than to "the protocol":

```sh
LOGOS_PROTOCOL_LIB=<protocol master>/lib/liblogos_protocol.dylib \
LOGOS_E2E_PROVIDER_LIB=<provider-capable protocol>/lib/liblogos_protocol.dylib \
  npm test          # consumer half, run against protocol master
```

### The browser build

`node test/web-e2e.js` (`npm run test:web`, `checks.<system>.web-e2e`) is the
Node e2e's case list over a real `MessageChannel`, JS on both ends: async call,
object result, `{_bytes}` round trip, introspection, event and withdrawal, sync
call, the frame cap, and an unauthorised call. It needs **nothing** installed —
no native library, no npm dependency — which is the point.

The sync case runs its provider in a `worker_threads` Worker, because a
synchronous call blocks the calling thread and a provider sharing that thread
could never answer it.

`test/web-bundle-e2e.js` (`checks.<system>.web-bundle-e2e`) puts three more
things on trial:

- the **bundle is browser code**: it is loaded into a `vm` context that has no
  `require`, no `process`, no `Buffer` and no Node builtin at all;
- the wire is the **real web transport**: the far end is `logos-web-shim`
  (`test/web-shim/`), a C++ `ModuleProxy` published on
  `logos::web::WebTransportHost` and reached through a **channel shim** — the
  browser SDK's channel bound to a child process's stdio instead of to a
  webview's `postMessage`. Both sides encode `{_bytes}` themselves, so a
  base64url disagreement fails an assertion instead of corrupting a payload;
- a typed client **generated from `calc.lidl`** drives that same bundled
  consumer.

```sh
nix build .#web-shim        # the C++ provider, on its own
result/bin/logos-web-shim --module calc_cpp --token tok   # one JSON message per line on stdio
```

## Status / limitations

- The Node build's provider method handlers are **synchronous** (return a value,
  not a Promise). Async request/response awaits a deferred-reply ABI. The browser
  build's `WebProvider` has no such limit — nothing holds a lock while a handler
  runs, so a handler may return a Promise and the Result is sent when it settles.
- The browser build's `getMethods()` returns a **Promise**: over a channel,
  introspection is a Methods/MethodsResult round trip like any other call.
- A closing channel does not fail the far peer's pending calls. The framed
  transport learns that from its socket; `IMessageChannel` has no equivalent
  notification, so the host that owns the webview's lifecycle is what has to
  tear the peer down (`WebClient#destroy`). The same note is on
  `WebRpcConnection` on the C++ side.

### What each half needs from logos-protocol

The two halves of this SDK have *different* upstream requirements, and the flake
pin is driven by the stricter one:

| half | needs | on logos-protocol master? |
|---|---|---|
| consumer (`LogosClient`, `lp_client_*`) | a shared `liblogos_protocol` + a Qt-free plain transport | **yes** — verified: async call, event, `getMethods`, `callSync` all round-trip |
| provider (`Provider`, `lp_provider_*`) | the C ABI actually *serving* a module | **no** — logos-protocol#12 is still open |

The shared library is merged (logos-protocol#4): master installs
`$out/lib/liblogos_protocol.{so,dylib}` in the ordinary `logos-protocol` /
`logos-protocol-lib` package, alongside the static archive. It is *not* a
separate package there, so `flake.nix` resolves
`logos-protocol-shared or logos-protocol` and works against either pin.

Serving is not. On master `lp_provider_register()` returns `LP_OK`, stores the
callbacks and opens no socket; `lp_provider_emit_event` / `lp_provider_save_token`
return `LP_ERR_UNSUPPORTED`. `Provider.register()` probes for exactly that and
throws a descriptive error instead of letting it surface as a consumer-side
"Connection refused" 30 s later. Until logos-protocol#12–#16 merge, `flake.nix`
pins the branch at the tip of that stack; flipping it to master afterwards is a
one-line change.

Codegen additionally needs a shared `liblogos_lidl_c` (logos-lidl#6, also still
open — master builds only a static `logos_lidl_c`). The Node e2e skips the
codegen round-trip when `LOGOS_LIDL_LIB` is unset, so the rest of the suite does
not depend on it.

**The browser build needs none of this.** It needs a logos-protocol with the
**web transport** only for `test/web-shim` — the C++ provider it is tested
against — and nothing at all at runtime. That is why `flake.nix` carries two
protocol inputs: `logos-protocol` (the web transport, what this SDK's browser
half is written against) and `protocol-with-serving-provider` (the branch where
`lp_provider_*` actually serves, needed only by the Node e2e's provider child).
They collapse into one input the day the provider ABI lands on master; the same
goes for `lidl-with-shared-c-abi`. Each is named off `logos-*` deliberately: the
workspace retargets an input by NAME, and the whole point of those two is to
stay on their own branch.
