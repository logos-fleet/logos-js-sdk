'use strict';
// Shared by the three e2e suites (test/e2e.js, test/web-e2e.js,
// test/web-bundle-e2e.js). Deliberately tiny: an assert that names what failed,
// a sleep, a poll with a deadline, and the one child-process pattern every
// suite has - wait for a provider fixture to announce READY on a stream.
const { spawn } = require('node:child_process');

function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `pred` until it holds or `budgetMs` passes; `what` names the wait. */
async function waitFor(pred, budgetMs, what, { intervalMs = 10 } = {}) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${budgetMs}ms waiting for ${what}`);
}

/**
 * Spawn a provider fixture and resolve once it prints READY on `stream`
 * ('stdout' or 'stderr'), or reject if it exits first or stays silent for
 * `timeoutMs`. `echo`, when given, prefixes every line of that stream onto
 * this process's stderr - for a fixture whose stdout IS the wire.
 */
function spawnReady(command, args, { stream, timeoutMs, what, echo, ...spawnOpts }) {
  const child = spawn(command, args, spawnOpts);
  const ready = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`${what} did not print READY in ${timeoutMs / 1000}s`)), timeoutMs);
    let buf = '';
    child[stream].setEncoding('utf8');
    child[stream].on('data', (d) => {
      buf += d;
      if (echo !== undefined) process.stderr.write(`${echo}${d}`);
      if (buf.includes('READY')) { clearTimeout(to); resolve(); }
    });
    child.on('exit', (code) => { clearTimeout(to); reject(new Error(`${what} exited early with code ${code}`)); });
  });
  return { child, ready };
}

module.exports = { assert, sleep, waitFor, spawnReady };
