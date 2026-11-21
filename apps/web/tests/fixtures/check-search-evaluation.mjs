import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const browser=await chromium.launch({headless:true}); const page=await browser.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message))
try {
 await page.goto('http://127.0.0.1:4184/tests/fixtures/search-dashboard-evaluation.html')
 await page.locator('#inspect-url').fill('https://example.com/')
 await page.locator('#crawl-delivery').fill('00000000-0000-0000-0000-000000000004')
 await page.getByRole('button',{name:'Compare saved crawl'}).click()
 await page.getByText('title · unknown', {exact:false}).waitFor()
 assert.match(await page.locator('body').innerText(), /not_attempted/)
 await page.getByRole('button',{name:'Load more crawl evidence'}).click()
 await page.getByText('Evaluation omitted due to size', {exact:false}).waitFor()
 assert.deepEqual(errors,[])
 console.log('PASS: evaluation-only crawl and independently paginated omitted evaluation render')
} finally { await browser.close() }
