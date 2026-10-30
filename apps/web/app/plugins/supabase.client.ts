import { createClient, type User } from '@supabase/supabase-js'

export default defineNuxtPlugin((nuxtApp) => {
  const config = useRuntimeConfig()
  const user = useState<User | null>('auth:user', () => null)
  const ready = useState('auth:ready', () => false)
  const supabase = createClient(config.public.supabaseUrl, config.public.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  })

  // Keep the server and initial client render identical. Restoring a browser
  // session before hydration can leave server-rendered form controls disabled.
  nuxtApp.hook('app:mounted', () => {
    supabase.auth.onAuthStateChange((_event, session) => {
      user.value = session?.user ?? null
      ready.value = true
    })
    void supabase.auth.getSession().then(({ data, error }) => {
      user.value = error ? null : data.session?.user ?? null
      ready.value = true
    }).catch(() => { ready.value = true })
  })

  return { provide: { supabase } }
})
