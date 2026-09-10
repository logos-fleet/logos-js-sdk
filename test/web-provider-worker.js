'use strict';
// The sync half of the browser-SDK e2e: the same `calc_js` provider, served
// from ANOTHER THREAD.
//
// It has to be another thread for the sync case to mean anything: callSync
// blocks the calling thread until the Result arrives, so a provider sharing
// that thread could never answer. A worker is the Node-shaped stand-in for what
// a browser does with a Web Worker and a SharedArrayBuffer pump.
const { workerData } = require('node:worker_threads');
const { WebProvider } = require('../src/web/index.js');
const { messagePortChannel } = require('../src/web/channel.js');

const provider = new WebProvider('calc_js', {
  channel: messagePortChannel(workerData.port),
  onError: (e) => console.error('[worker provider]', e && e.message),
});

provider.register({
  handlers: {
    add: (a, b) => a + b,
    greet: (name) => ({ message: `hello ${name}` }),
    echoBytes: (v) => v,
  },
  events: ['ticked'],
});
provider.saveToken('web_e2e_app', 'web-e2e-tok');
