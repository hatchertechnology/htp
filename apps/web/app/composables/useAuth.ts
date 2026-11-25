import type { User } from '@supabase/supabase-js'

type SessionResolver = Promise<User | null>

export function useAuth() {
  const nuxtApp = useNuxtApp()
  const user = useState<User | null>('auth:user', () => null)
  const ready = useState('auth:ready', () => false)

  async function accessToken() {
    const { data, error } = await nuxtApp.$supabase.auth.getSession()
    if (error) throw error
    return data.session?.access_token ?? null
  }

  // Route middleware runs before `app:mounted` (and before auth:ready in the
  // static build), so it waits on the plugin's session resolver instead of the flag.
  async function resolveSession(): Promise<User | null> {
    if (ready.value) return user.value
    const pending = (nuxtApp as unknown as { $authSession?: SessionResolver }).$authSession
    if (!pending) return user.value
    try { return await pending } catch { return null }
  }

  async function signOut(): Promise<{ error: string | null }> {
    try {
      const result = await nuxtApp.$supabase.auth.signOut({ scope: 'local' })
      if (result.error) return { error: 'Could not sign out. Please try again.' }
      user.value = null
      ready.value = true
      return { error: null }
    } catch {
      return { error: 'Could not sign out. Check your connection and try again.' }
    }
  }

  return { user, ready, accessToken, resolveSession, signOut }
}
