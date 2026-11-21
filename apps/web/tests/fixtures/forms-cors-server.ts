// Synthetic HTTPS origins; bind to loopback only. Never use live credentials.
import { handle } from '../../../../supabase/functions/form-submit/index.ts'
const cert = await Deno.readTextFile(Deno.env.get('FORMS_TEST_CERT')!)
const key = await Deno.readTextFile(Deno.env.get('FORMS_TEST_KEY')!)
Deno.serve({ hostname: '127.0.0.1', port: 56575, cert, key }, req => {
  const url = new URL(req.url)
  if (url.hostname === 'visitor.test') return new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
  // Simulate an API limiter response before a receiver can verify the origin.
  if (url.pathname === '/early') return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '600' } })
  return handle(req, name => Promise.resolve(name === 'charge_form_ingress' ? (url.pathname === '/form-limit' ? 'rate_limited' : 'ok') : name === 'website_form_origin_allowed' ? true : { error: 'rate_limited' }))
})
