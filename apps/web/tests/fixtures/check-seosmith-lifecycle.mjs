import { chromium } from 'playwright'
const browser=await chromium.launch({headless:true})
try {
 const page=await browser.newPage(), errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 await page.goto(`http://127.0.0.1:${process.env.BING_FIXTURE_PORT || 4177}/tests/fixtures/seosmith-lifecycle.html`)
 await page.getByRole('button',{name:'Compare findings with baseline'}).click()
 await page.getByText(/1 resolved/).waitFor()
 await page.getByText('Finding lifecycle and rule coverage').click()
 await page.getByRole('button',{name:'Read history'}).click()
 await page.getByText('Saved history · missing title').waitFor()
 await page.getByText('Observed failures in loaded rows:',{exact:false}).waitFor()
 if (errors.length) throw new Error(errors.join('\n'))
 console.log('Lifecycle comparison and indexed history fixture passed; no page errors.')
} finally { await browser.close() }
