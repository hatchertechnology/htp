import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
test('shared admission is service-only, bounded and counts unknown clients', async () => {
  const db = new PGlite()
  try {
    await db.exec('create role anon; create role authenticated; create role service_role;')
    await db.exec(await readFile(new URL('../migrations/20261122000900_forms_client_admission.sql', import.meta.url), 'utf8'))
    const hash='a'.repeat(64)
    await db.exec('set role anon')
    await assert.rejects(()=>db.query('select public.charge_form_client($1)',[hash]), /permission denied/)
    await db.exec('reset role; set role service_role')
    for(let i=0;i<100;i++) assert.equal((await db.query('select public.charge_form_client($1) value',[hash])).rows[0].value,'ok')
    assert.equal((await db.query('select public.charge_form_client($1) value',[hash])).rows[0].value,'rate_limited')
    assert.equal((await db.query('select public.charge_form_client($1) value',['b'.repeat(64)])).rows[0].value,'ok')
    await db.exec('reset role')
    await db.exec("update public.website_form_client_windows set started_at=now()-interval '11 minutes'")
    await db.exec('set role service_role')
    assert.equal((await db.query('select public.charge_form_client($1) value',[hash])).rows[0].value,'ok')
    await db.exec('reset role')
    await db.exec('update public.website_form_global_window set count=10000')
    await db.exec('set role service_role')
    assert.equal((await db.query('select public.charge_form_client($1) value',["c".repeat(64)])).rows[0].value,'rate_limited')
  } finally { await db.close() }
})
