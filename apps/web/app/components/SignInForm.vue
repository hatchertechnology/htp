<script setup lang="ts">
import { safeReturnPath } from '#shared/utils/return-path'

const { ready } = useAuth()
const { $supabase } = useNuxtApp()
const route = useRoute()
const email = ref('')
const password = ref('')
const showPassword = ref(false)
const mode = ref<'signin' | 'signup'>('signin')
const busy = ref(false)
const error = ref('')
const notice = ref('')

function changeMode() {
  mode.value = mode.value === 'signin' ? 'signup' : 'signin'
  error.value = ''
  notice.value = ''
  password.value = ''
}

async function submit() {
  if (busy.value) return
  error.value = ''
  notice.value = ''
  busy.value = true
  try {
    const result = mode.value === 'signin'
      ? await $supabase.auth.signInWithPassword({ email: email.value.trim(), password: password.value })
      : await $supabase.auth.signUp({ email: email.value.trim(), password: password.value })
    if (result.error) {
      error.value = result.error.code === 'invalid_credentials'
        ? 'That email and password did not match. Please try again.'
        : result.error.code === 'email_not_confirmed'
          ? 'Confirm your email address, then sign in here.'
          : result.error.message
      return
    }
    password.value = ''
    if (mode.value === 'signup' && !result.data.session) {
      notice.value = 'Check your email to confirm your account, then sign in.'
      mode.value = 'signin'
      return
    }
    // A validated return path only; anything else goes to the overview.
    await navigateTo(safeReturnPath(route.query.redirect) ?? '/', { replace: true })
  } catch {
    error.value = 'Could not reach Supabase. Check your connection and try again.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form class="auth-form" @submit.prevent="submit">
    <UFormField label="Email" name="email">
      <UInput id="sign-in-email" v-model="email" type="email" placeholder="you@example.com" autocomplete="email" size="lg" required :disabled="busy || !ready" />
    </UFormField>
    <UFormField label="Password" name="password" :help="mode === 'signup' ? 'Use at least 8 characters.' : undefined">
      <UInput v-model="password" :type="showPassword ? 'text' : 'password'" placeholder="Enter your password" :autocomplete="mode === 'signin' ? 'current-password' : 'new-password'" size="lg" required :minlength="mode === 'signup' ? 8 : undefined" :disabled="busy || !ready">
        <template #trailing><UButton type="button" variant="link" color="neutral" :icon="showPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'" :aria-label="showPassword ? 'Hide password' : 'Show password'" :aria-pressed="showPassword" @click="showPassword = !showPassword" /></template>
      </UInput>
    </UFormField>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="form-notice" role="status">{{ notice }}</p>
    <UButton block type="submit" size="lg" :loading="busy" :disabled="!ready">{{ mode === 'signin' ? 'Sign in' : 'Create account' }}</UButton>
    <p class="account-toggle">{{ mode === 'signin' ? 'New here?' : 'Already have an account?' }} <button type="button" :disabled="busy" @click="changeMode">{{ mode === 'signin' ? 'Create an account' : 'Sign in' }}</button></p>
    <p class="auth-provider"><UIcon name="i-lucide-lock-keyhole" />Authentication by Supabase</p>
  </form>
</template>
