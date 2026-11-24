import { describe, expect, it } from 'vitest'
import {
  beginBody, confirmBody, isSavedResult, isUnknownOutcome, isVerifiedResult, originQuery, ownerMessage, ownerPath, ownerUrl, pageQuery, parseChallenge, saveBody, sessionEndedError, tokenFromTxtValue,
} from '../shared/utils/forms-owner-client'

const site = '10000000-0000-0000-0000-000000000001'
const form = '10000000-0000-0000-0000-000000000002'
const host = '30000000-0000-0000-0000-000000000001'
const base = 'https://api.example.test'
const token = 'a'.repeat(64)
const txt = `htp-verification=${token}`
const apiError = (code?: string) => Object.assign(new Error('fetch failed'), code ? { data: { code } } : {})

describe('owner route allowlist', () => {
  it('maps only the owner routes this client uses', () => {
    expect(ownerPath.eligibility(site)).toBe(`/websites/${site}/forms/pilot-eligibility`)
    expect(ownerPath.hosts(site)).toBe(`/websites/${site}/forms/hosts`)
    expect(ownerPath.origins(site)).toBe(`/websites/${site}/forms/origins`)
    expect(ownerPath.forms(site)).toBe(`/websites/${site}/forms`)
    expect(ownerPath.begin(site)).toBe(`/websites/${site}/forms/host-verifications`)
    expect(ownerPath.confirm(host)).toBe(`/forms/host-verifications/${host}/confirm`)
  })
  it.each(['not-a-uuid', `${site}/../x`, `${site}?x=1`, ''])('rejects website id %s before any request', id => {
    expect(() => ownerPath.hosts(id)).toThrow(/Unsupported forms request/)
    expect(() => ownerPath.begin(id)).toThrow(/Unsupported forms request/)
  })
  it('rejects a responses path and a sub-resource on the owner collection', () => {
    expect(() => ownerUrl(`/websites/${site}/forms/${form}/responses`, base)).toThrow(/Unsupported forms request/)
    expect(() => ownerUrl(`/websites/${site}/forms/hosts/extra`, base)).toThrow(/Unsupported forms request/)
    expect(() => ownerUrl(`/websites/${site}/forms/${form}`, base)).toThrow(/Unsupported forms request/)
    expect(() => ownerUrl(`/websites/${site}/forms/host-verifications/${host}`, base)).toThrow(/Unsupported forms request/)
    expect(() => ownerUrl(`/forms/host-verifications/${host}/confirm/extra`, base)).toThrow(/Unsupported forms request/)
    expect(() => ownerUrl(`/forms/host-verifications/${host}/confirm`, base)).not.toThrow()
  })
  it('builds a URL on the API origin only and refuses a non-https or credentialed base', () => {
    expect(ownerUrl(ownerPath.hosts(site), `${base}/`, pageQuery(0))).toBe(`${base}/websites/${site}/forms/hosts?limit=100&offset=0`)
    expect(() => ownerUrl(ownerPath.hosts(site), undefined)).toThrow(/needs an API base URL/)
    expect(() => ownerUrl(ownerPath.hosts(site), 'http://api.example.test')).toThrow()
    expect(() => ownerUrl(ownerPath.hosts(site), 'https://user:pw@api.example.test')).toThrow()
  })
  it('sends the origins filter as a validated form id', () => {
    expect(ownerUrl(ownerPath.origins(site), base, originQuery(form, 0))).toBe(`${base}/websites/${site}/forms/origins?form_id=${form}&limit=100&offset=0`)
    expect(() => originQuery('form-1', 0)).toThrow(/Unsupported forms request/)
  })
  it('bounds paging offsets', () => {
    expect(() => pageQuery(-1)).toThrow(/offset/)
    expect(() => pageQuery(1.5)).toThrow(/offset/)
  })
  it('reports the session end as a definite unauthorized refusal', () => {
    expect(isUnknownOutcome('begin', sessionEndedError())).toBe(false)
    expect(ownerMessage('confirm', sessionEndedError())).toBe('Your session has ended. Sign in again.')
  })
})

describe('owner request bodies', () => {
  it('begins with the exact lowercase hostname and no other fields', () => {
    expect(beginBody('  WWW.Example.COM ')).toEqual({ hostname: 'www.example.com' })
  })
  it('extracts only a 64-hex token from the TXT value', () => {
    expect(tokenFromTxtValue(txt)).toBe(token)
    expect(confirmBody(txt)).toEqual({ token })
    for (const value of [undefined, 'htp-verification=', `htp-verification=${'g'.repeat(64)}`, `other=${token}`, `htp-verification=${token}0`]) {
      expect(() => tokenFromTxtValue(value)).toThrow(/Unsupported verification value/)
    }
  })
  it('creates a form without form_id and updates only when form_id is present', () => {
    const common = { formId: null, formKey: 'cleaning_quote', name: 'Cleaning', active: true, hostIds: [host] }
    const fields = [{ key: 'name', label: 'Name', kind: 'text' as const, required: true, max_length: 100, extra: 'drop' } as never]
    const created = saveBody({ ...common, fields })
    expect(created).toEqual({ form_key: 'cleaning_quote', name: 'Cleaning', fields: [{ key: 'name', label: 'Name', kind: 'text', required: true, max_length: 100 }], active: true, host_ids: [host] })
    expect('form_id' in created).toBe(false)
    expect(saveBody({ ...common, formId: form, fields }).form_id).toBe(form)
  })
  it('rejects a malformed host id in a save body before any request', () => {
    expect(() => saveBody({ formId: null, formKey: 'k', name: 'n', fields: [], active: false, hostIds: ['host-1'] })).toThrow(/Unsupported forms request/)
  })
})

describe('owner success bodies', () => {
  it('accepts a begin result only with a verified host id and a valid TXT value', () => {
    const valid = { host_id: host, hostname: 'www.example.com', txt_name: '_htp-verification.www.example.com', txt_value: txt, expires_in_hours: 24 }
    expect(parseChallenge(valid)).toEqual({ host_id: host, txt_name: valid.txt_name, txt_value: txt })
    expect(parseChallenge({ ...valid, host_id: 'host-1' })).toBeNull()
    expect(parseChallenge({ ...valid, txt_value: 'htp-verification=short' })).toBeNull()
    expect(parseChallenge({ ...valid, txt_name: '' })).toBeNull()
    expect(parseChallenge(null)).toBeNull()
  })
  it('accepts a confirm result only for the same host and verified true', () => {
    expect(isVerifiedResult({ host_id: host, verified: true, status: 'verified' }, host)).toBe(true)
    expect(isVerifiedResult({ host_id: host, verified: false }, host)).toBe(false)
    expect(isVerifiedResult({ host_id: form, verified: true }, host)).toBe(false)
  })
  it('accepts a save result only with a uuid id and the requested key', () => {
    expect(isSavedResult({ id: form, form_key: 'cleaning_quote', name: 'x', fields: [], active: true }, 'cleaning_quote')).toBe(true)
    expect(isSavedResult({ id: 'not-a-uuid', form_key: 'cleaning_quote' }, 'cleaning_quote')).toBe(false)
    expect(isSavedResult({ id: form, form_key: 'other' }, 'cleaning_quote')).toBe(false)
  })
})

describe('ambiguous versus refused outcomes', () => {
  it.each(['begin', 'confirm'] as const)('treats a transport failure on %s as unknown', step => {
    expect(isUnknownOutcome(step, apiError())).toBe(true)
    expect(ownerMessage(step, apiError())).toMatch(/unknown|may or may not/)
  })
  it.each(['verification_unknown_outcome', 'verification_unavailable', 'something_new'])('treats %s as unknown on confirm', code => {
    expect(isUnknownOutcome('confirm', apiError(code))).toBe(true)
  })
  it.each([
    ['confirm', 'dns_record_not_verified', 'Could not verify the DNS record yet. Check the value and try again.'],
    ['confirm', 'challenge_expired_or_changed', 'This challenge expired or was replaced. Create a new DNS challenge.'],
    ['begin', 'host_limit', 'This website has reached its limit of 64 hosts.'],
    ['begin', 'rate_limited', 'Too many verification requests. Try again in 10 minutes.'],
  ] as const)('reports %s %s as a definite refusal', (step, code, text) => {
    expect(isUnknownOutcome(step, apiError(code))).toBe(false)
    expect(ownerMessage(step, apiError(code))).toBe(text)
  })
  it('treats 5xx-class save results and missing codes as unknown, and reports definite save refusals', () => {
    expect(isUnknownOutcome('save-create', apiError('save_unknown_outcome'))).toBe(true)
    expect(isUnknownOutcome('save-update', apiError())).toBe(true)
    expect(isUnknownOutcome('save-create', apiError('invalid_request'))).toBe(false)
    expect(ownerMessage('save-create', apiError('invalid_request'))).toMatch(/refused/)
    expect(ownerMessage('save-create', apiError())).toMatch(/may or may not have been saved/)
    expect(ownerMessage('save-update', apiError())).toMatch(/Reopen this form/)
  })
  it('never treats a list failure as an unknown write', () => {
    expect(isUnknownOutcome('list', apiError())).toBe(false)
    expect(ownerMessage('list', apiError())).toBe('Could not load forms. Please try again.')
  })
})
