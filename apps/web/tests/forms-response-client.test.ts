import { describe, it, expect } from 'vitest'
import { responseUrl, responseBody, responseResult, responseUnknown, staticResponseEnabled } from '../shared/utils/forms-response-client'
const id = '10000000-0000-0000-0000-000000000001'
describe('independent response REST contract', () => {
  it('requires all flags exactly true', () => {
    for (const flags of [[true,true,undefined],[true,true,false],[false,true,true],[true,false,true], [true,true,'true']]) expect(staticResponseEnabled(...flags as [unknown,unknown,unknown])).toBe(false)
    expect(staticResponseEnabled(true,true,true)).toBe(true)
  })
  it('uses exact UUID paths and status body', () => {
    expect(responseUrl(id,id,id,true,'https://api.example.test')).toBe(`https://api.example.test/websites/${id}/forms/${id}/responses/${id}/status`)
    expect(responseUrl(id,id,id,false,'https://api.example.test')).toMatch(new RegExp(`${id}$`))
    expect(() => responseUrl(id,id,'../x',false,'https://api.example.test')).toThrow()
    for (const status of ['new','reviewed','spam']) expect(responseBody(status)).toEqual({status})
    expect(() => responseBody('deleted')).toThrow()
  })
  it('checks success affinity and treats unexpected results as unknown', () => {
    expect(responseResult({id,deleted:true},id)).toBe(true)
    expect(responseResult({id,status:'spam'},id,'spam')).toBe(true)
    expect(responseResult({id,status:'new'},id,'spam')).toBe(false)
    expect(responseResult({id:'other',deleted:true},id)).toBe(false)
    for (const code of ['forms_owner_response_disabled','not_found','unauthorized','invalid_request','response_notification_sending']) expect(responseUnknown({data:{code}})).toBe(false)
    for (const code of ['response_status_unknown_outcome','response_delete_unknown_outcome','unexpected']) expect(responseUnknown({data:{code}})).toBe(true)
    expect(responseUnknown(new Error('network'))).toBe(true)
  })
})
