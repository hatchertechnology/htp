// Rewrite a fixture report by exact text substitution (no re-serialisation):
//   node prep.mjs <in.json> <out.json> [--request UUID] [--website UUID] [--gen N] [--ts ISO] [--mutate]
// --request/--website replace the fixture's 00000000-0000-4000-8000-00000000000{1,2}.
// --ts replaces started_at (2026-11-16T12:00:00Z) and sets finished_at to ts+60s.
// --mutate changes the first finding's details.bytes 0 to 1 (a full-equality violation).
import { readFileSync, writeFileSync } from 'node:fs';
const [inp, out, ...a] = process.argv.slice(2);
const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
let t = readFileSync(inp, 'utf8');
const rq = opt('--request'), ws = opt('--website'), gen = opt('--gen'), ts = opt('--ts');
const swap = (from, to) => { if (!t.includes(from)) throw new Error(`missing ${from}`); t = t.split(from).join(to); };
if (rq) swap('00000000-0000-4000-8000-000000000001', rq);
if (ws) swap('00000000-0000-4000-8000-000000000002', ws);
if (gen) { if (!t.includes('"binding_generation":1')) throw new Error('gen'); t = t.replace('"binding_generation":1', `"binding_generation":${gen}`); }
if (ts) {
  const end = new Date(Date.parse(ts) + 60000).toISOString().replace('.000Z', 'Z');
  swap('"started_at":"2026-11-16T12:00:00Z"', `"started_at":"${ts}"`);
  swap('"finished_at":"2026-11-16T12:01:00Z"', `"finished_at":"${end}"`);
}
if (a.includes('--mutate')) {
  // Change one details value of the first finding (a full-equality violation).
  const f0 = t.indexOf('"findings":[');
  const k = t.indexOf('"bytes":0', f0);
  if (f0 < 0 || k < 0) throw new Error('no details.bytes to mutate');
  t = t.slice(0, k) + '"bytes":1' + t.slice(k + '"bytes":0'.length);
}
writeFileSync(out, t);
