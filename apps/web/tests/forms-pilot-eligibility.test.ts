import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
const requireUser=vi.hoisted(()=>vi.fn())
vi.mock('../server/utils/google',()=>({requireDashboardUser:requireUser}))
import { pilotEligibility } from '../server/utils/forms-pilot'
const event={} as H3Event
const site='10000000-0000-0000-0000-000000000001', otherSite='10000000-0000-0000-0000-000000000002', owner='20000000-0000-0000-0000-000000000001', other='20000000-0000-0000-0000-000000000002'
const config={formsPilotEnabled:true,formsPilotWebsiteId:site,formsPilotOwnerId:owner,apiBaseUrl:'https://api.example.test',public:{rolloutFormsPilot:true}}
const raw=vi.fn(), query=vi.fn(), header=vi.fn()
beforeEach(()=>{
 config.formsPilotEnabled=true;config.public.rolloutFormsPilot=true;config.formsPilotWebsiteId=site;config.formsPilotOwnerId=owner
 vi.stubGlobal('useRuntimeConfig',()=>config);vi.stubGlobal('getQuery',query.mockReturnValue({website_id:site}));vi.stubGlobal('setHeader',header);vi.stubGlobal('$fetch',{raw:raw.mockResolvedValue({status:200,_data:{id:site}})})
 requireUser.mockResolvedValue({id:owner,authorization:'Bearer synthetic-token'})
})
afterEach(()=>{vi.unstubAllGlobals();vi.resetAllMocks()})
it('defaults closed when either rollout switch or server-owned binding is absent',async()=>{
 config.formsPilotEnabled=false;expect(await pilotEligibility(event)).toEqual({eligible:false})
 config.formsPilotEnabled=true;config.public.rolloutFormsPilot=false;expect(await pilotEligibility(event)).toEqual({eligible:false})
 config.public.rolloutFormsPilot=true;config.formsPilotOwnerId='';expect(await pilotEligibility(event)).toEqual({eligible:false})
 expect(requireUser).not.toHaveBeenCalled();expect(raw).not.toHaveBeenCalled()
})
it('allows only the verified bound owner and exact owned website without returning identifiers',async()=>{
 expect(await pilotEligibility(event)).toEqual({eligible:true})
 expect(header).toHaveBeenCalledWith(event,'Cache-Control','no-store')
 expect(raw).toHaveBeenCalledWith(`https://api.example.test/websites/${site}`,expect.objectContaining({headers:{Authorization:'Bearer synthetic-token'},redirect:'error',retry:0}))
})
it('denies the same owner on another site and another owner on the approved site',async()=>{
 query.mockReturnValue({website_id:otherSite});expect(await pilotEligibility(event)).toEqual({eligible:false})
 query.mockReturnValue({website_id:site});requireUser.mockResolvedValue({id:other,authorization:'Bearer synthetic-token'});expect(await pilotEligibility(event)).toEqual({eligible:false})
 expect(raw).not.toHaveBeenCalled()
})
it('fails closed for ownership denial, malformed requests and upstream failures',async()=>{
 raw.mockResolvedValueOnce({status:403,_data:{id:site}}).mockResolvedValueOnce({status:200,_data:{id:otherSite}}).mockRejectedValueOnce(new Error('offline'))
 for(let i=0;i<3;i++)expect(await pilotEligibility(event)).toEqual({eligible:false})
 query.mockReturnValue({website_id:['duplicate']});expect(await pilotEligibility(event)).toEqual({eligible:false})
})
it('does not allow an invalid, expired or anonymous dashboard session',async()=>{
 requireUser.mockRejectedValue(Object.assign(new Error('session ended'),{statusCode:401}))
 await expect(pilotEligibility(event)).rejects.toMatchObject({statusCode:401});expect(raw).not.toHaveBeenCalled()
})
