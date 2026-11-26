// Envelope sender for the schema-4 route (and the legacy route, with the legacy endpoint as the endpoint argument).
//   node send.mjs <endpoint> <token> <report.json> [--id UUID] [--timeout MS]
// Prints one JSON line: {status, ms, end_epoch_ms, bytes (chars), body_bytes (the UTF-8 request body actually sent), body}. The delivery id defaults to the
// report's request.request_id (the route binds them). Idempotency-Key = delivery id.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [endpoint, token, file, ...rest] = process.argv.slice(2);
const idIx = rest.indexOf('--id');
const toIx = rest.indexOf('--timeout');
const timeoutMs = toIx >= 0 ? Number(rest[toIx + 1]) : 60000;
const raw = readFileSync(file, 'utf8');
const id = idIx >= 0 ? rest[idIx + 1] : JSON.parse(raw).request.request_id;
const sha = createHash('sha256').update(raw, 'utf8').digest('hex');
const body = JSON.stringify({ delivery_id: id, sha256: sha, report_json: raw });
const t0 = performance.now();
let status = 0, text = '';
try {
  const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': id }, body, signal: AbortSignal.timeout(timeoutMs) });
  status = r.status; text = await r.text();
} catch (e) { text = String(e); }
console.log(JSON.stringify({ status, ms: Math.round(performance.now() - t0), end_epoch_ms: Date.now(), bytes: raw.length, body_bytes: Buffer.byteLength(body), sha, id, body: text.slice(0, 400) }));
