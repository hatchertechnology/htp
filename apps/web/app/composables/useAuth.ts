import type { User } from '@supabase/supabase-js'

export function useAuth() {
  const nuxtApp = useNuxtApp()
  const user = useState<User | null>('auth:user', () => null)
  const ready = useState('auth:ready', () => false)

  async function accessToken() {
    const { data, error } = await nuxtApp.$supabase.auth.getSession()
    if (error) throw error
    return data.session?.access_token ?? null
  }

  return { user, ready, accessToken }
}
