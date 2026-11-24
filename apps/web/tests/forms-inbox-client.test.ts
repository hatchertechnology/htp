import { describe, expect, it } from 'vitest'
import { formsInboxPath, formsInboxUrl, staticFormsInboxReads } from '../shared/utils/forms-inbox-client'

const site = '10000000-0000-0000-0000-000000000001'
const form = '10000000-0000-0000-0000-000000000002'
const base = 'https://api.example.test'

describe('forms inbox read paths', () => {
  it('maps the list and response collections only', () => {
    expect(formsInboxPath(site)).toBe(`/websites/${site}/forms`)
    expect(formsInboxPath(site, form)).toBe(`/websites/${site}/forms/${form}/responses`)
  })
  it.each(['not-a-uuid', `${site}/../x`, `${site}?x=1`, ''])('rejects website id %s', id => {
    expect(() => formsInboxPath(id)).toThrow(/Unsupported forms inbox request path/)
  })
  it('rejects a malformed form id', () => {
    expect(() => formsInboxPath(site, 'form-1')).toThrow(/Unsupported forms inbox request path/)
  })
})

describe('forms inbox request URLs', () => {
  it('builds a bounded GET URL on the API origin', () => {
    expect(formsInboxUrl(formsInboxPath(site, form), { limit: 100, offset: 200 }, `${base}/`))
      .toBe(`${base}/websites/${site}/forms/${form}/responses?limit=100&offset=200`)
  })
  it.each([0, 101, 1.5, Number.NaN])('rejects page size %s', limit => {
    expect(() => formsInboxUrl(formsInboxPath(site), { limit, offset: 0 }, base)).toThrow(/page size/)
  })
  it.each([-1, 1.5])('rejects offset %s', offset => {
    expect(() => formsInboxUrl(formsInboxPath(site), { limit: 10, offset }, base)).toThrow(/offset/)
  })
  it('requires a valid https API origin', () => {
    expect(() => formsInboxUrl(formsInboxPath(site), { limit: 10, offset: 0 }, undefined)).toThrow(/needs an API base URL/)
    expect(() => formsInboxUrl(formsInboxPath(site), { limit: 10, offset: 0 }, 'http://api.example.test')).toThrow()
  })
})

describe('static read gate', () => {
  it('is on only when the static build and the pilot rollout are both selected', () => {
    expect(staticFormsInboxReads(true, true)).toBe(true)
    expect(staticFormsInboxReads(true, false)).toBe(false)
    expect(staticFormsInboxReads(false, true)).toBe(false)
    expect(staticFormsInboxReads(undefined, undefined)).toBe(false)
    expect(staticFormsInboxReads('true', 'true')).toBe(false)
  })
})
