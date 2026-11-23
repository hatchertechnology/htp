import { Readable } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const raw=vi.fn(), status=vi.fn()
const config={public:{rolloutForms:false,rolloutFormsPilot:false,supabaseUrl:'https://example.test'}}
beforeEach(()=>{
 config.public.rolloutForms=false;config.public.rolloutFormsPilot=false
 vi.stubGlobal('defineEventHandler',(handler:unknown)=>handler);vi.stubGlobal('useRuntimeConfig',()=>config);vi.stubGlobal('createError',(v:{statusCode:number,message:string})=>Object.assign(new Error(v.message),v));vi.stubGlobal('setHeader',vi.fn());vi.stubGlobal('setResponseStatus',status);vi.stubGlobal('$fetch',{raw:raw.mockResolvedValue({status:200,_data:{ok:true}})})
})
afterEach(()=>{vi.unstubAllGlobals();vi.resetAllMocks();vi.resetModules()})
const event=()=>({node:{req:Readable.from([Buffer.from(JSON.stringify({recipient_id:'fixture',token:'fixture'}))])}})
it('denies confirmation for held and pilot modes without forwarding',async()=>{
 const handler=(await import('../server/api/forms/confirm.post')).default
 await expect(handler(event() as never)).rejects.toMatchObject({statusCode:503})
 config.public.rolloutForms=true;config.public.rolloutFormsPilot=true
 await expect(handler(event() as never)).rejects.toMatchObject({statusCode:503});expect(raw).not.toHaveBeenCalled()
})
it('preserves legacy confirmation when the existing rollout is on and pilot mode is off',async()=>{
 config.public.rolloutForms=true
 const handler=(await import('../server/api/forms/confirm.post')).default
 expect(await handler(event() as never)).toEqual({ok:true});expect(raw).toHaveBeenCalledOnce();expect(status).toHaveBeenCalledWith(expect.anything(),200)
})
