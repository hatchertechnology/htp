<script setup lang="ts">
import { SIGN_IN_PATH, isPublicRoute } from '#shared/utils/public-routes'

const router = useRouter()
const auth = useAuth()

// Covers the paths the route middleware cannot see: a session that expires
// mid-app, and the SSR build's first hydration pass (the middleware skips it
// because the session is only restored in app:mounted).
watch([() => auth.ready.value, () => auth.user.value], () => {
  if (!auth.ready.value || auth.user.value) return
  const current = router.currentRoute.value
  if (isPublicRoute(current.path)) return
  void router.replace({ path: SIGN_IN_PATH, query: { redirect: current.fullPath } })
}, { immediate: true })
</script>

<template>
  <AppShell><slot /></AppShell>
</template>
