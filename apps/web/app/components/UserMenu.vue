<script setup lang="ts">
import { SIGN_IN_PATH } from '#shared/utils/public-routes'

const auth = useAuth()
const toast = useToast()
const email = computed(() => auth.user.value?.email || '')
const monogram = computed(() => (email.value || 'H').slice(0, 1).toUpperCase())

// Set before the session clears so the default layout's expiry watch stands
// down and the explicit sign-out lands on /sign-in with no return path.
const explicitSignOut = useState('auth:explicit-signout', () => false)

async function signOut() {
  explicitSignOut.value = true
  try {
    const result = await auth.signOut()
    if (result.error) {
      toast.add({ title: 'Sign out failed', description: result.error, color: 'error', icon: 'i-lucide-alert-triangle' })
      return
    }
    await navigateTo(SIGN_IN_PATH, { replace: true })
  } finally {
    explicitSignOut.value = false
  }
}

const items = computed(() => [
  { label: email.value || 'Not signed in', type: 'label' as const },
  { label: 'Connections', icon: 'i-lucide-link', to: '/connections' },
  { label: 'Sign out', icon: 'i-lucide-log-out', onSelect: signOut },
])
</script>

<template>
  <UDropdownMenu :items="items" :content="{ align: 'end' }" :ui="{ content: 'user-menu-content' }">
    <button type="button" class="user-menu-button" :aria-label="`Account menu for ${email || 'your account'}`" aria-haspopup="menu">
      <span class="account-monogram" aria-hidden="true">{{ monogram }}</span>
      <span class="user-menu-email">{{ email || 'Your account' }}</span>
      <UIcon name="i-lucide-chevron-down" />
    </button>
  </UDropdownMenu>
</template>
