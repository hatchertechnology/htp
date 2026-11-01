import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { effectScope, ref, watch } from 'vue'
import { useRepositoryIssues } from '../app/composables/useRepositoryIssues'

const request = vi.fn()
let site = ref('site-a')
let scope = effectScope()
const payload = (number: number, more = false) => ({ repository_url: 'https://github.com/example/site', issues: [{ number, title: `Issue ${number}` }], has_more: more })
beforeEach(() => {
  scope = effectScope(); site = ref('site-a')
  vi.stubGlobal('ref', ref); vi.stubGlobal('watch', watch)
  vi.stubGlobal('onBeforeUnmount', vi.fn())
  vi.stubGlobal('failureMessage', (e: Error) => e.message)
  vi.stubGlobal('useWorkspace', () => ({ user: ref({ id: 'owner' }), selectedId: site, request }))
})
afterEach(() => { scope.stop(); vi.resetAllMocks(); vi.unstubAllGlobals() })

it('clears issues immediately on website changes and ignores the previous website response', async () => {
  let resolveOld!: (value: unknown) => void
  request.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  request.mockResolvedValueOnce(payload(2))
  const model = scope.run(() => useRepositoryIssues())!
  site.value = 'site-b'
  expect(model.result.value).toBeNull()
  await Promise.resolve()
  resolveOld(payload(1)); await Promise.resolve()
  expect(model.result.value?.issues.map(issue => issue.number)).toEqual([2])
  expect(request.mock.calls[0]![1].signal.aborted).toBe(true)
})
it('appends pages without duplicates and resets pagination when the status changes', async () => {
  request.mockResolvedValueOnce(payload(1, true)).mockResolvedValueOnce(payload(2)).mockResolvedValueOnce(payload(3))
  const model = scope.run(() => useRepositoryIssues())!
  await Promise.resolve()
  await model.load(true)
  expect(model.result.value?.issues.map(issue => issue.number)).toEqual([1, 2])
  expect(request.mock.calls[1]![1].query.page).toBe(2)
  model.state.value = 'closed'
  expect(model.result.value).toBeNull()
  await Promise.resolve()
  expect(request.mock.calls[2]![1].query).toEqual({ state: 'closed', page: 1 })
  expect(model.result.value?.issues.map(issue => issue.number)).toEqual([3])
})
