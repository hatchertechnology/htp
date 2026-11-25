import { createClient, type User } from '@supabase/supabase-js'

export default defineNuxtPlugin((nuxtApp) => {
  const config = useRuntimeConfig()
  const user = useState<User | null>('auth:user', () => null)
  const ready = useState('auth:ready', () => false)
  const supabase = createClient(config.public.supabaseUrl, config.public.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  })

  // Settles with the session the route middleware waits on. In the SSR build it
  // resolves from the app:mounted hook; in the static build, immediately.
  let settleSession: (value: User | null) => void = () => {}
  const authSession = new Promise<User | null>((resolve) => { settleSession = resolve })

  function restoreSession() {
    supabase.auth.onAuthStateChange((_event, session) => {
      user.value = session?.user ?? null
      ready.value = true
      settleSession(user.value)
    })
    void supabase.auth.getSession().then(({ data, error }) => {
      user.value = error ? null : data.session?.user ?? null
      ready.value = true
      settleSession(user.value)
    }).catch(() => { ready.value = true; settleSession(null) })
  }

  if (config.public.staticDashboard === true) {
    // Static build: ssr is off, so there is no hydration to protect. The first
    // route middleware runs before app:mounted and needs the session now.
    restoreSession()
  } else {
    // Keep the server and initial client render identical. Restoring a browser
    // session before hydration can leave server-rendered form controls disabled.
    nuxtApp.hook('app:mounted', restoreSession)
  }

  return { provide: { supabase, authSession } }
})
