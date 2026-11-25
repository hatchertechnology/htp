import { describe, expect, it } from 'vitest'
import { notificationUrl, notificationPage, notificationResult, notificationUnknown } from '../shared/utils/forms-notification-client'
const id='10000000-0000-0000-0000-000000000001'
describe('owner notification client', () => {
 it('uses exact scoped routes and bounded pagination', () => {
  expect(notificationUrl(id,id,'recipients','https://api.example.test',100)).toBe(`https://api.example.test/websites/${id}/forms/${id}/recipients?limit=100&offset=100`)
  expect(notificationUrl(id,id,'delivery-jobs','https://api.example.test',undefined,id)).toContain(`/delivery-jobs/${id}/retry`)
  expect(()=>notificationUrl('../rpc',id,'recipients','https://api.example.test')).toThrow()
  expect(()=>notificationUrl(id,id,'recipients','https://api.example.test',-1)).toThrow()
 })
 it('projects safe metadata and rejects malformed pages', () => {
  const row={id,email:'<script>@example.test',enabled:true,verified_at:null,created_at:'today',token:'secret'}
  expect(notificationPage({items:[row],has_more:false},'recipients').items[0]).not.toHaveProperty('token')
  expect(()=>notificationPage({items:[],has_more:true},'recipients')).toThrow()
 })
 it('requires exact write acknowledgements and treats transport as unknown', () => {
  expect(notificationResult({recipient_id:id,requested:true},'create')).toBe(true)
  expect(notificationResult({recipient_id:id,disabled:true},'disable','wrong')).toBe(false)
  expect(notificationResult({job_id:id,retry_requested:false},'retry',id)).toBe(false)
  expect(notificationUnknown(new Error('timeout'))).toBe(true)
  expect(notificationUnknown({data:{code:'notification_not_retryable'}})).toBe(false)
 })
})
