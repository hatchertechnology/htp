import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
const getUser=vi.hoisted(()=>vi.fn())
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({auth:{getUser}})}))
import { pilotEligibility } from '../server/utils/forms-pilot'
const event={} as H3Event, site='10000000-0000-0000-0000-000000000001', owner='20000000-0000-0000-0000-000000000001', other='20000000-0000-0000-0000-000000000002'
const raw=vi.fn()
beforeEach(()=>{
 vi.stubGlobal('useRuntimeConfig',()=>({formsPilotEnabled:true,formsPilotWebsiteId:site,formsPilotOwnerId:owner,apiBaseUrl:'https://api.example.test',public:{rolloutFormsPilot:true,supabaseUrl:'https://supabase.example.test',supabasePublishableKey:'public'}}))
 vi.stubGlobal('getQuery',()=>({website_id:site}));vi.stubGlobal('getHeader',()=> 'Bearer synthetic.token');vi.stubGlobal('setHeader',vi.fn());vi.stubGlobal('createError',(value:{statusCode:number,message:string})=>Object.assign(new Error(value.message),value));vi.stubGlobal('$fetch',{raw:raw.mockResolvedValue({status:200,_data:{id:site}})})
})
afterEach(()=>{vi.unstubAllGlobals();vi.resetAllMocks()})
it('uses the verified non-anonymous Supabase user and forwards that same bearer for ownership',async()=>{
 getUser.mockResolvedValue({data:{user:{id:owner,is_anonymous:false}},error:null})
 expect(await pilotEligibility(event)).toEqual({eligible:true});expect(getUser).toHaveBeenCalledWith('synthetic.token');expect(raw).toHaveBeenCalledOnce()
})
it('rejects anonymous and expired sessions before owner lookup',async()=>{
 getUser.mockResolvedValueOnce({data:{user:{id:owner,is_anonymous:true}},error:null}).mockResolvedValueOnce({data:{user:null},error:{message:'expired'}})
 await expect(pilotEligibility(event)).rejects.toMatchObject({statusCode:401});await expect(pilotEligibility(event)).rejects.toMatchObject({statusCode:401});expect(raw).not.toHaveBeenCalled()
})
it('does not trust user-editable metadata as the bound owner',async()=>{
 getUser.mockResolvedValue({data:{user:{id:other,is_anonymous:false,user_metadata:{id:owner,formsPilotOwnerId:owner}}},error:null})
 expect(await pilotEligibility(event)).toEqual({eligible:false});expect(raw).not.toHaveBeenCalled()
})
