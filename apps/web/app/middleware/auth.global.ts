import { SIGN_IN_PATH, isPublicRoute } from '#shared/utils/public-routes'
import { safeReturnPath } from '#shared/utils/return-path'

// Signed-out visitors see the sign-in page and nothing else. Public routes are
// exact matches; the sign-in page sends a signed-in visitor back to `redirect`.
export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) return
  const nuxtApp = useNuxtApp()
  // SSR build only: the session is restored in app:mounted, after this pass.
  // The default layout's auth watch redirects once auth:ready is true.
  if (nuxtApp.isHydrating && nuxtApp.payload.serverRendered) return
  const path = to.path.replace(/\/$/, '') || '/'
  if (isPublicRoute(to.path) && path !== SIGN_IN_PATH) return
  const user = await useAuth().resolveSession()
  if (path === SIGN_IN_PATH) {
    if (user) return navigateTo(safeReturnPath(to.query.redirect) ?? '/', { replace: true })
    return
  }
  if (!user) return navigateTo({ path: SIGN_IN_PATH, query: { redirect: to.fullPath } }, { replace: true })
})
