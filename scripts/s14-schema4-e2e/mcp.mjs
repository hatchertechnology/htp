// Web/MCP display read path for one audit: website_audit_detail, and (when the detail answers
// EXPORT_REQUIRED) the export protocol start -> chunks -> close, reassembling the audit-detail JSON.
//   node mcp.mjs <api> <jwt> <website_id> <delivery_id> <expected-report.json>
// Exit 0 only if the reassembled detail's report_json is byte-identical to the expected report and the
// export's sha256/byteLength match the bytes received.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [api, jwt, website_id, delivery_id, expected] = process.argv.slice(2);
let id = 0;
async function call(name, args) {
  const r = await fetch(`${api}/mcp/secured`, { method: 'POST', headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
  const j = await r.json(); const res = j.result;
  const text = res?.structuredContent ?? (res?.content?.[0]?.text ? JSON.parse(res.content[0].text) : null);
  return { isError: !!res?.isError, body: text };
}
const out = { detail: null };
const d = await call('website_audit_detail', { website_id, delivery_id });
out.detail = d.isError ? { isError: true, code: d.body?.code } : { inline: true, keys: Object.keys(d.body || {}).length };
let detail = d.isError ? null : d.body;
if (d.body?.code === 'EXPORT_REQUIRED') {
  const s = await call('website_audit_export_start_v1', { website_id, delivery_id });
  if (s.isError) { console.log(JSON.stringify({ ...out, export: s.body })); process.exit(1); }
  const { exportId, byteLength, sha256, representation } = s.body;
  const parts = []; let offset = 0;
  for (;;) {
    const c = await call('website_audit_export_chunk_v1', { website_id, delivery_id, exportId, offset });
    if (c.isError) { console.log(JSON.stringify({ ...out, chunkError: c.body })); process.exit(1); }
    const b = Buffer.from(c.body.dataBase64, 'base64'); parts.push(b); offset = c.body.nextOffset; if (c.body.eof) break;
  }
  const bytes = Buffer.concat(parts);
  await call('website_audit_export_close_v1', { website_id, delivery_id, exportId });
  const hash = createHash('sha256').update(bytes).digest('hex');
  out.export = { representation, byteLength, bytes: bytes.length, sha256_ok: hash === sha256, length_ok: bytes.length === byteLength };
  detail = JSON.parse(bytes.toString('utf8'));
}
const want = readFileSync(expected, 'utf8');
out.report_json_identical = detail?.report_json === want;
out.schema_version = detail?.report ? detail.report.schema_version : null;
out.summary_version = detail?.summary?.summary_version ?? null;
console.log(JSON.stringify(out));
process.exit(out.report_json_identical && (!out.export || (out.export.sha256_ok && out.export.length_ok)) ? 0 : 1);
