import { createClient } from '@supabase/supabase-js'
import type { H3Event } from 'h3'
export function googleStore(event: H3Event) {
  const config = useRuntimeConfig(event)
  if (!config.supabaseServiceRoleKey) throw createError({ statusCode: 503, message: 'Google background sync is not configured yet.' })
  return createClient(config.public.supabaseUrl, config.supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
}
