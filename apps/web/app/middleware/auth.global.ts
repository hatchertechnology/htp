import { isPublicRoute, isSignInPath } from '#shared/utils/public-routes'
import { safeReturnPath } from '#shared/utils/return-path'

// Signed-out visitors see the sign-in page and nothing else. Public routes are
// exact matches; the sign-in page sends a signed-in visitor back to `redirect`.
export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) return
  const nuxtApp = useNuxtApp()
  // SSR build only: the session is restored in app:mounted, after this pass.
  // The default layout's auth watch redirects once auth:ready is true.
  if (nuxtApp.isHydrating && nuxtApp.payload.serverRendered) return
  const signIn = isSignInPath(to.path)
  if (isPublicRoute(to.path) && !signIn) return
  const user = await useAuth().resolveSession()
  if (signIn) {
    if (user) return navigateTo(safeReturnPath(to.query.redirect) ?? '/', { replace: true })
    return
  }
  if (!user) return navigateTo({ path: '/sign-in', query: { redirect: to.fullPath } }, { replace: true })
})
