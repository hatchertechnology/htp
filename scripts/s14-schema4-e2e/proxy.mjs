// Counting and (optionally) throttling HTTP forwarder for the e2e harness.
//
//   node proxy.mjs --listen PORT --to HOST:PORT [--rate BYTES_PER_SEC] [--log FILE]
//
// * Forwards every request unchanged to the target; responses are not throttled.
// * --rate paces the REQUEST BODY on its way to the target (the upload direction), by writing it in
//   16 KiB pieces against a token clock. It is a documented stand-in for a slower uplink: it limits
//   what the server behind it can read, which is what the API's body deadline measures. It does not
//   model latency, loss or TCP slow start (tc/netem needs root, which this host does not give us).
// * Each request appends one JSON line to --log: method, path, request body bytes, the time from the
//   first to the last body byte reaching the target (up_ms), the target's status, total ms.
//   This is how the API -> Supabase commit body size is measured (path /rest/v1/rpc/commit_seosmith_audit_v4).
import http from 'node:http';
import { appendFileSync } from 'node:fs';

const a = process.argv.slice(2);
const opt = (k, d = null) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const listen = Number(opt('--listen'));
const [thost, tport] = opt('--to').split(':');
const rate = Number(opt('--rate', 0));
const logFile = opt('--log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PIECE = 16 * 1024;

const server = http.createServer(async (req, res) => {
  const t0 = performance.now();
  const headers = { ...req.headers, host: `${thost}:${tport}` };
  const up = http.request({ host: thost, port: Number(tport), method: req.method, path: req.url, headers }, (ur) => {
    let rb = 0;
    res.writeHead(ur.statusCode, ur.headers);
    ur.on('data', (c) => { rb += c.length; res.write(c); });
    ur.on('end', () => {
      res.end();
      if (logFile) {
        appendFileSync(logFile, JSON.stringify({ method: req.method, path: req.url.split('?')[0], req_bytes: reqBytes, up_ms: Math.round(upMs), status: ur.statusCode, total_ms: Math.round(performance.now() - t0), resp_bytes: rb }) + '\n');
      }
    });
  });
  let reqBytes = 0, upMs = 0, first = null;
  up.on('error', () => { try { res.writeHead(502); res.end(); } catch { /* client gone */ } });
  req.on('aborted', () => up.destroy());
  try {
    for await (const chunk of req) {
      for (let o = 0; o < chunk.length; o += PIECE) {
        const piece = chunk.subarray(o, o + PIECE);
        if (first === null) first = performance.now();
        if (!up.write(piece)) await new Promise((r) => up.once('drain', r));
        reqBytes += piece.length;
        if (rate > 0) { const due = first + (reqBytes / rate) * 1000; const w = due - performance.now(); if (w > 1) await sleep(w); }
      }
    }
    upMs = first === null ? 0 : performance.now() - first;
    up.end();
  } catch { up.destroy(); }
});
server.keepAliveTimeout = 65000;
server.listen(listen, '127.0.0.1', () => console.error(`proxy ${listen} -> ${thost}:${tport} rate=${rate || 'unthrottled'} log=${logFile || '-'}`));
