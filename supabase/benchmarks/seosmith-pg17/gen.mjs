// Synthetic payload generator for the H01 native Postgres dry-run. No real customer data.
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const [fixtures, out, nSmallArg] = process.argv.slice(2)
const nSmall = Number(nSmallArg)
const SITE = '00000000-0000-4000-8000-000000000002'
const legacy = JSON.parse(readFileSync(`${fixtures}/seosmith-expanded.json`, 'utf8'))
const write = (name, raw) => { writeFileSync(`${out}/${name}.json`, raw); console.log(`${name}\t${Buffer.byteLength(raw)} bytes`) }
const fresh = (base, mutate) => {
  const r = structuredClone(base)
  r.request.request_id = randomUUID(); r.request.website_id = SITE; r.request.binding_generation = 1
  if (mutate) mutate(r)
  return r
}
// Grow a legacy report by cloning its pages under distinct URLs until the target size.
const grown = target => fresh(legacy, r => {
  const base = r.pages, per = JSON.stringify(base).length / base.length
  const pages = []
  for (let i = 0; pages.length * per < target && pages.length < 19000; i++) {
    const p = structuredClone(base[i % base.length])
    if (i >= base.length && typeof p.url === 'string') p.url = p.url.replace(/\/?$/, `/dry-${i}/`)
    if (i >= base.length && typeof p.final_url === 'string') p.final_url = p.url
    pages.push(p)
  }
  r.pages = pages
})
const pad = (obj, bytes) => { const s = JSON.stringify(obj); return s.slice(0, -1) + ' '.repeat(Math.max(0, bytes - Buffer.byteLength(s))) + '}' }

for (let i = 0; i < nSmall; i++) write(`legacy-small-${String(i).padStart(5, '0')}`, JSON.stringify(fresh(legacy), null, i % 2 ? 2 : 0))
write('legacy-pages-1m', JSON.stringify(grown(1 << 20)))
write('legacy-pages-2m', JSON.stringify(grown(2 << 20)))
write('legacy-pages-4m', JSON.stringify(grown(4 << 20)))
write('legacy-pages-8m', JSON.stringify(grown(8 << 20)))
write('legacy-pad-16m', pad(fresh(legacy), 16777216))            // exactly at the cap
write('legacy-pre-v2', JSON.stringify(fresh(legacy, r => { r.schema_version = 2 }))) // old receiver must reject
write('legacy-post-small', JSON.stringify(fresh(legacy)))
write('legacy-post-8m', JSON.stringify(grown(8 << 20)))
write('v2-complete', readFileSync(`${fixtures}/contracts/v2-complete.json`, 'utf8'))   // frozen bytes
for (const n of ['v2-partial', 'v2-truncated']) {                                     // frozen fixtures share one request id
  const r = JSON.parse(readFileSync(`${fixtures}/contracts/${n}.json`, 'utf8')); r.request.request_id = randomUUID()
  write(n, JSON.stringify(r))
}
{ // same frozen bytes cannot be re-delivered under a new id without changing them; import path gets its own id
  const r = JSON.parse(readFileSync(`${fixtures}/contracts/v2-complete.json`, 'utf8')); r.request.request_id = randomUUID()
  write('v2-complete-import', JSON.stringify(r))
  const o = JSON.parse(readFileSync(`${fixtures}/contracts/v2-complete.json`, 'utf8')); o.request.request_id = randomUUID()
  write('v2-oversize', pad(o, 16777217))                         // cap + 1 byte must be rejected
}
// Raw scanner inputs (called directly; not stored)
const N = 7_999_000
write('scan-legacy-tokens-16m', '{"schema_version":1,"padding":[' + '0,'.repeat(N) + '0]}')
write('scan-v2-tokens-16m', '{"schema_version":2,"padding":[' + '0,'.repeat(N) + '0]}')
write('scan-v2-strings-16m', '{"schema_version":2,"padding":[' + '"[{\\"x\\":]}",'.repeat(1_200_000) + '"z"]}')
write('scan-v2-deep-contiguous', '{"schema_version":2,"padding":' + '['.repeat(1_000_000) + '0' + ']'.repeat(1_000_000) + '}')
write('scan-v2-deep-late', '{"schema_version":2,"padding":[' + '0,'.repeat(N - 200) + '0],"x":' + '{"x":'.repeat(64) + '0' + '}'.repeat(64) + '}')
write('scan-v2-deep-sparse', '{"schema_version":2,"x":' + ('{"k":"' + 'a'.repeat(200_000) + '","x":').repeat(64) + '0' + '}'.repeat(64) + '}')
write('scan-v2-dup-late', '{"schema_version":2,"padding":[' + '0,'.repeat(N - 200) + '0],"a":1,"\\u0061":2}')
write('scan-v2-escaped-version', '{"padding":[' + '0,'.repeat(N - 200) + '0],"schema_vers\\u0069on":2,"x":' + '['.repeat(65) + ']'.repeat(65) + '}')
