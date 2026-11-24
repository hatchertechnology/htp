import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, watch } from 'vue'
import { useSeosmith } from '../app/composables/useSeosmith'
import { JSON_CONTENT_TYPE, SAVED_DETAIL_DEADLINE_MS, SEOSMITH_IMPORT_MAX_BYTES, resolveSeosmithReadPath, resolveSeosmithImportPath } from '../shared/utils/seosmith-client'

const base = 'https://api.example.test'
const SITE = '00000000-0000-4000-8000-000000000001'
const RUN = '00000000-0000-4000-8000-000000000002'
const listPath = `/api/websites/${SITE}/seo/audits`
const detailPath = `${listPath}/${RUN}`

describe('default (staticDashboard off) leaves Seosmith paths unchanged', () => {
  it.each([listPath, detailPath, `${listPath}?limit=50`])('returns %s as-is', path => {
    expect(resolveSeosmithReadPath(path, false, undefined)).toBe(path)
    expect(resolveSeosmithReadPath(path, false, base)).toBe(path)
  })
})

describe('static mode maps the two saved reads onto the API origin', () => {
  it('maps the collection and one run', () => {
    expect(resolveSeosmithReadPath(listPath, true, `${base}/`)).toBe(`${base}/websites/${SITE}/seo/audits`)
    expect(resolveSeosmithReadPath(detailPath, true, base)).toBe(`${base}/websites/${SITE}/seo/audits/${RUN}`)
  })
  it('refuses the bounded /dashboard proxy, work, lifecycle, import and malformed paths', () => {
    const refused = [
      `${detailPath}/dashboard`,
      `${detailPath}/work`,
      `${listPath}/lifecycle`,
      `${listPath}/url-lifecycle`,
      `${listPath}/import`,
      `${listPath}/`,
      `${listPath}?limit=50`,
      `/api/websites/${SITE}/seo/audits/../secrets`,
      `//evil.example${listPath}`,
      `/api/websites/not-a-uuid/seo/audits`,
    ]
    for (const path of refused) expect(() => resolveSeosmithReadPath(path, true, base), path).toThrow(/Unsupported Seosmith request path/)
  })
  it('requires a valid API base', () => {
    expect(() => resolveSeosmithReadPath(listPath, true, undefined)).toThrow(/needs an API base URL/)
    expect(() => resolveSeosmithReadPath(listPath, true, 'http://api.example.test')).toThrow(/must be an https origin/)
  })
})

describe('saved detail media type', () => {
  it.each(['application/json', 'application/json; charset=utf-8', 'application/problem+json'])('accepts %s', value => {
    expect(JSON_CONTENT_TYPE.test(value)).toBe(true)
  })
  it.each(['text/html', 'application/jsonp', 'text/plain; application/json', ''])('rejects %j', value => {
    expect(JSON_CONTENT_TYPE.test(value)).toBe(false)
  })
})

describe('useSeosmith transport', () => {
  const request = vi.fn()
  const fetchMock = vi.fn()
  const accessToken = vi.fn()
  let scope = effectScope()
  let workspace: any
  let session: ReturnType<typeof ref<number>>
  const run = { delivery_id: RUN, scan_at: '2026-01-01T00:00:00Z', received_at: '2026-01-01T00:00:00Z', ingestion_source: 'import' }
  const detail = () => ({
    ...run,
    summary: { schema_version: 2, outcome: 'partial', pages: { checked: 1, html: 1, images: 0, http_errors: 0, fetch_errors: 0 }, severities: { critical: 0, alert: 0, warning: 0 } },
    report: { schema_version: 2, request: {}, pages: [], findings: [], evidence_contract: { version: 99 } },
  })
  const history = { items: [run], has_more: false, next_cursor: null }

  function setup(publicConfig: Record<string, unknown>) {
    scope = effectScope()
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('onBeforeUnmount', vi.fn())
    vi.stubGlobal('failureMessage', (cause: Error) => cause.message)
    vi.stubGlobal('useRuntimeConfig', () => ({ public: publicConfig }))
    session = ref(0)
    vi.stubGlobal('useState', () => session)
    workspace = { user: ref({ id: 'owner' }), selectedId: ref(SITE), selected: ref({ id: SITE, fqdn: 'example.test' }), accessToken, request }
    vi.stubGlobal('useWorkspace', () => workspace)
    vi.stubGlobal('fetch', fetchMock)
    return scope.run(() => useSeosmith())!
  }

  beforeEach(() => {
    accessToken.mockResolvedValue('tok')
    request.mockImplementation(async (url: string) => (url.endsWith('/seo/audits') ? history : detail()))
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(detail()), { headers: { 'content-type': 'application/json' } }))
  })
  afterEach(() => { scope.stop(); vi.resetAllMocks(); vi.unstubAllGlobals() })

  it('static: lists history from the API origin and reads the detail directly with the owner bearer', async () => {
    const model = setup({ staticDashboard: true, boundedSavedDetail: false, apiBaseUrl: base })
    await vi.waitFor(() => expect(model.selected.value?.delivery_id).toBe(RUN))
    expect(request.mock.calls[0]![0]).toBe(`${base}/websites/${SITE}/seo/audits`)
    expect(request.mock.calls[0]![1]).toMatchObject({ query: { limit: 50 } })
    expect(fetchMock).toHaveBeenCalledWith(`${base}/websites/${SITE}/seo/audits/${RUN}`, expect.objectContaining({ headers: { Authorization: 'Bearer tok' }, redirect: 'error' }))
  })

  it('static: refuses a detail body that is not JSON, even when the status is 200', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html></html>', { headers: { 'content-type': 'text/html' } }))
    const model = setup({ staticDashboard: true, boundedSavedDetail: false, apiBaseUrl: base })
    await vi.waitFor(() => expect(model.error.value).toMatch(/could not load/))
    expect(model.selected.value).toBeNull()
  })

  it('static: refuses a detail whose delivery_id does not match the chosen run', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...detail(), delivery_id: 'other' }), { headers: { 'content-type': 'application/json' } }))
    const model = setup({ staticDashboard: true, boundedSavedDetail: false, apiBaseUrl: base })
    await vi.waitFor(() => expect(model.error.value).toMatch(/could not load/))
    expect(model.selected.value).toBeNull()
  })

  it.each([true, false])('imports once and reads the receipt run (static=%s)', async staticDashboard => {
    const model = setup({ staticDashboard, apiBaseUrl: base })
    await vi.waitFor(() => expect(model.selected.value).not.toBeNull())
    request.mockClear()
    request.mockImplementation(async (url: string) => url.endsWith('/import') ? { delivery_id: RUN } : url.endsWith('/audits') ? history : detail())
    await model.importFile(new File(['{}'], 'report.json'))
    expect(request.mock.calls[0]).toEqual([`${staticDashboard ? base : '/api'}/websites/${SITE}/seo/audits/import`, expect.objectContaining({ method: 'POST', body: { report_json: '{}' }, retry: 0 })])
    if (staticDashboard) expect(request.mock.calls[0]![1]).toMatchObject({ redirect: 'error', timeout: 30_000 })
    expect(request.mock.calls.filter(([url]) => url.endsWith('/import'))).toHaveLength(1)
    expect(model.notice.value).toMatch(/Run saved/)
  })

  it.each(['size', 'utf8', 'json'])('bounds and validates files before submission: %s', async kind => {
    const model = setup({ staticDashboard: true, apiBaseUrl: base })
    await vi.waitFor(() => expect(model.selected.value).not.toBeNull())
    request.mockClear()
    const file = { size: kind === 'size' ? SEOSMITH_IMPORT_MAX_BYTES + 1 : 2, text: vi.fn().mockResolvedValue(kind === 'utf8' ? 'é'.repeat(SEOSMITH_IMPORT_MAX_BYTES / 2 + 1) : 'invalid') } as unknown as File
    await model.importFile(file)
    expect(request).not.toHaveBeenCalled()
    expect(model.error.value).toMatch(kind === 'json' ? /valid JSON/ : /at most/)
    if (kind === 'size') expect(file.text).not.toHaveBeenCalled()
  })

  it.each(['file', 'post'].flatMap(stage => ['session', 'owner', 'website'].map(change => [stage, change])))('discards stale import during %s after %s change', async (stage, change) => {
    const model = setup({ staticDashboard: true, apiBaseUrl: base })
    await vi.waitFor(() => expect(model.selected.value).not.toBeNull())
    let finish!: (value: any) => void
    const pending = new Promise(resolve => { finish = resolve })
    request.mockClear()
    request.mockImplementation(async (url: string) => url.endsWith('/import') ? pending : history)
    const work = model.importFile({ size: 2, text: () => stage === 'file' ? pending as Promise<string> : Promise.resolve('{}') } as File)
    if (stage === 'post') await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    if (change === 'session') { workspace.user.value = null; workspace.user.value = { id: 'owner' }; session.value++ }
    if (change === 'owner') workspace.user.value = { id: 'another-owner' }
    if (change === 'website') workspace.selectedId.value = '00000000-0000-4000-8000-000000000003'
    finish(stage === 'file' ? '{}' : { delivery_id: RUN })
    await work
    expect(model.notice.value).toBe('')
    expect(model.importing.value).toBe(false)
    if (stage === 'file') expect(request.mock.calls.some(([url]) => url.endsWith('/import'))).toBe(false)
  })

  it('reads the receipt run even when it is absent from refreshed history', async () => {
    const model = setup({ staticDashboard: true, apiBaseUrl: base })
    await vi.waitFor(() => expect(model.selected.value).not.toBeNull())
    const imported = '00000000-0000-4000-8000-000000000009'
    request.mockImplementation(async (url: string) => url.endsWith('/import') ? { delivery_id: imported } : history)
    fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify({ ...detail(), delivery_id: url.split('/').pop() }), { headers: { 'content-type': 'application/json' } }))
    await model.importFile(new File(['{}'], 'report.json'))
    expect(model.selected.value?.delivery_id).toBe(imported)
    expect(model.notice.value).toMatch(/Run saved/)
  })

  it('does not announce success when receipt readback fails', async () => {
    const model = setup({ staticDashboard: true, apiBaseUrl: base })
    await vi.waitFor(() => expect(model.selected.value).not.toBeNull())
    request.mockImplementation(async (url: string) => url.endsWith('/import') ? { delivery_id: RUN } : history)
    fetchMock.mockResolvedValue(new Response('{}', { status: 404 }))
    await model.importFile(new File(['{}'], 'report.json'))
    expect(model.notice.value).toBe('')
    expect(model.error.value).toMatch(/could not load/)
  })

  it('accepts the inclusive byte limit and ignores a second concurrent click', async () => {
    const model = setup({ staticDashboard: true, apiBaseUrl: base })
    await vi.waitFor(() => expect(model.selected.value).not.toBeNull())
    let finish!: (value: unknown) => void
    request.mockClear()
    request.mockImplementation(async (url: string) => url.endsWith('/import') ? new Promise(resolve => { finish = resolve }) : history)
    const raw = '{}' + ' '.repeat(SEOSMITH_IMPORT_MAX_BYTES - 2)
    const work = model.importFile(new File([raw], 'report.json'))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await model.importFile(new File(['{}'], 'other.json'))
    expect(request.mock.calls.filter(([url]) => url.endsWith('/import'))).toHaveLength(1)
    expect(request.mock.calls[0]![1].body.report_json).toBe(raw)
    finish({ delivery_id: RUN }); await work
    expect(model.notice.value).toMatch(/Run saved/)
  })

  it('discards receipt detail completing after a session change', async () => {
    const model = setup({ staticDashboard: true, apiBaseUrl: base })
    await vi.waitFor(() => expect(model.selected.value).not.toBeNull())
    let finish!: (value: Response) => void
    request.mockImplementation(async (url: string) => url.endsWith('/import') ? { delivery_id: RUN } : { items: [], has_more: false, next_cursor: null })
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const work = model.importFile(new File(['{}'], 'report.json'))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    session.value++
    finish(new Response(JSON.stringify(detail()), { headers: { 'content-type': 'application/json' } }))
    await work
    expect(model.selected.value).toBeNull()
    expect(model.notice.value).toBe('')
  })

  it.each([null, {}, { delivery_id: 'bad' }])('rejects malformed receipt %j without retry', async receipt => {
    const model = setup({ staticDashboard: true, apiBaseUrl: base })
    await vi.waitFor(() => expect(model.selected.value).not.toBeNull())
    request.mockClear(); request.mockResolvedValue(receipt)
    await model.importFile(new File(['{}'], 'report.json'))
    expect(request).toHaveBeenCalledTimes(1)
    expect(model.error.value).toMatch(/receipt/)
    expect(model.notice.value).toBe('')
  })

  it.each([401, 403, 413, 422, 500])('preserves import failure without retry: %s', async status => {
    const model = setup({ staticDashboard: true, apiBaseUrl: base })
    await vi.waitFor(() => expect(model.selected.value).not.toBeNull())
    request.mockClear(); request.mockRejectedValue(new Error(`status ${status}`))
    await model.importFile(new File(['{}'], 'report.json'))
    expect(request).toHaveBeenCalledTimes(1)
    expect(model.error.value).toBe(`status ${status}`)
    expect(model.notice.value).toBe('')
  })

  it('default: history and detail keep the same-origin proxy paths', async () => {
    const model = setup({ staticDashboard: false, boundedSavedDetail: false, apiBaseUrl: base })
    await vi.waitFor(() => expect(model.selected.value?.delivery_id).toBe(RUN))
    expect(request.mock.calls[0]![0]).toBe(listPath)
    expect(request.mock.calls[1]![0]).toBe(detailPath)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('default with the bounded flag: detail still uses the Nuxt /dashboard route', async () => {
    const model = setup({ staticDashboard: false, boundedSavedDetail: true, apiBaseUrl: base })
    await vi.waitFor(() => expect(model.selected.value?.delivery_id).toBe(RUN))
    expect(fetchMock).toHaveBeenCalledWith(`${detailPath}/dashboard`, expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }))
    expect(fetchMock.mock.calls[0]![1]).not.toHaveProperty('redirect', 'error')
  })

  it('static: a detail read that never finishes fails at the deadline with the typed message', async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }))
      const model = setup({ staticDashboard: true, boundedSavedDetail: false, apiBaseUrl: base })
      await vi.advanceTimersByTimeAsync(SAVED_DETAIL_DEADLINE_MS + 1)
      expect(model.error.value).toBe('Seosmith reports could not load. Try again.')
      expect(model.selected.value).toBeNull()
    } finally { vi.useRealTimers() }
  })

  // Near-envelope regressions. The stored detail body is the parsed report plus the raw report_json, both JSON-escaped.
  // Quotes double in size when escaped, so a raw report near the import limit yields a body several times larger.
  // Each must load: the browser applies no byte cap, only the deadline and cancellation.
  const envelopeFor = (rawBytes: number) => {
    const head = { schema_version: 2, request: {}, pages: [], findings: [], evidence_contract: { version: 99 } }
    const quotes = Math.floor((rawBytes - 200) / 2)
    const raw = JSON.stringify({ ...head, padding: '"'.repeat(quotes) })
    const padded = raw + ' '.repeat(rawBytes - raw.length)
    expect(new TextEncoder().encode(padded).length).toBe(rawBytes)
    const body = JSON.stringify({ ...detail(), report: JSON.parse(padded), report_json: padded })
    return body
  }
  it.each([
    ['import-limit raw report', SEOSMITH_IMPORT_MAX_BYTES],
    ['legacy 16 MiB raw report', 16_777_216],
  ])('static: a near-limit normal run loads (%s)', async (_name, rawBytes) => {
    const body = envelopeFor(rawBytes)
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(SEOSMITH_IMPORT_MAX_BYTES)
    fetchMock.mockResolvedValueOnce(new Response(body, { headers: { 'content-type': 'application/json' } }))
    const model = setup({ staticDashboard: true, boundedSavedDetail: false, apiBaseUrl: base })
    await vi.waitFor(() => expect(model.selected.value?.delivery_id).toBe(RUN))
    expect(model.error.value).toBe('')
  }, 60_000)

  it('static: a body with a declared Content-Length above the old import cap still loads', async () => {
    const body = envelopeFor(SEOSMITH_IMPORT_MAX_BYTES)
    fetchMock.mockResolvedValueOnce(new Response(body, { headers: { 'content-type': 'application/json', 'content-length': String(new TextEncoder().encode(body).length) } }))
    const model = setup({ staticDashboard: true, boundedSavedDetail: false, apiBaseUrl: base })
    await vi.waitFor(() => expect(model.selected.value?.delivery_id).toBe(RUN))
  }, 60_000)

  it('static: malformed detail JSON still surfaces the typed message', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"delivery_id":', { headers: { 'content-type': 'application/json' } }))
    const model = setup({ staticDashboard: true, boundedSavedDetail: false, apiBaseUrl: base })
    await vi.waitFor(() => expect(model.error.value).toMatch(/could not load/))
    expect(model.selected.value).toBeNull()
  })
})

describe('exact import routing', () => {
  it('maps only the owner import path and preserves legacy routing', () => {
    expect(resolveSeosmithImportPath(`${listPath}/import`, true, base)).toBe(`${base}/websites/${SITE}/seo/audits/import`)
    expect(resolveSeosmithImportPath(`${listPath}/import`, false, undefined)).toBe(`${listPath}/import`)
    for (const path of [listPath, `${listPath}/import/`, `${listPath}/import\n`, `${listPath}/import?x=1`, `${detailPath}/work`, '/api/websites/invalid/seo/audits/import']) {
      expect(() => resolveSeosmithImportPath(path, true, base)).toThrow()
    }
  })
})
