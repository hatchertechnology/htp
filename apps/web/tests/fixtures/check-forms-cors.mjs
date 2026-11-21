import { chromium } from 'playwright'
import assert from 'node:assert/strict'
const browser = await chromium.launch({ args: ['--no-proxy-server', '--host-resolver-rules=MAP visitor.test 127.0.0.1:56575, MAP api.test 127.0.0.1:56575'] })
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true })
  await page.goto('https://visitor.test/')
  const result = await page.evaluate(async () => {
    const id = '00000000-0000-0000-0000-000000000001'
    async function submit(path) {
      try {
        const response = await fetch(`https://api.test/${path}?form=${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ submission_id: '00000000-0000-0000-0000-000000000002', name: 'Ada' }) })
        return { status: response.status, retry: response.headers.get('retry-after') }
      } catch { return { error: 'opaque' } }
    }
    return { form: await submit('form-limit'), validation: await submit('validation'), early: await submit('early') }
  })
  assert.deepEqual(result, { form: { status: 429, retry: '600' }, validation: { status: 429, retry: '600' }, early: { error: 'opaque' } })
  console.log('PASS: verified receiver limits are readable; early preflight failure is opaque')
} finally { await browser.close() }
