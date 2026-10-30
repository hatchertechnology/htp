<script setup lang="ts">
const props = defineProps<{ context?: 'websites' }>()
const { user, ready } = useAuth()
const { $supabase } = useNuxtApp()
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
    }
  } catch {
    error.value = 'Could not reach Supabase. Check your connection and try again.'
  } finally {
    busy.value = false
  }
}

async function signOut() {
  busy.value = true
  error.value = ''
  try {
    const result = await $supabase.auth.signOut({ scope: 'local' })
    if (result.error) error.value = 'Could not sign out. Please try again.'
  } catch {
    error.value = 'Could not sign out. Check your connection and try again.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section id="your-session" class="account-panel surface" aria-labelledby="session-heading">
    <h2 id="session-heading">Your account</h2>
    <div class="session-state" aria-live="polite"><span :class="['status-dot', { 'is-connected': user }]" />{{ !ready ? 'Checking session…' : user ? 'Signed in' : 'Not signed in' }}</div>
    <template v-if="user">
      <div class="signed-in-account"><span class="account-avatar">{{ (user.email || 'U').slice(0, 1).toUpperCase() }}</span><div><strong>Welcome back</strong><p>{{ user.email }}</p></div></div>
      <p class="account-description">{{ props.context === 'websites' ? 'You can add and manage your website records.' : 'Choose a website to see its performance.' }}</p>
      <div class="session-detail"><UIcon name="i-lucide-shield-check" /><span>{{ props.context === 'websites' ? 'Your website records are private' : 'Your website records are private' }}</span></div>
      <UButton block color="neutral" variant="outline" size="lg" icon="i-lucide-log-out" :loading="busy" @click="signOut">Sign out</UButton>
    </template>
    <template v-else>
      <p class="account-description">{{ mode === 'signin' ? props.context === 'websites' ? 'Sign in to manage your websites.' : 'Sign in to view your websites and Analytics.' : 'Create an account to get started.' }}</p>
      <form class="auth-form" @submit.prevent="submit">
        <UFormField label="Email" name="email">
          <UInput id="account-email" v-model="email" type="email" placeholder="you@example.com" autocomplete="email" size="lg" required :disabled="busy || !ready" />
        </UFormField>
        <UFormField label="Password" name="password" :help="mode === 'signup' ? 'Use at least 8 characters.' : undefined">
          <UInput v-model="password" :type="showPassword ? 'text' : 'password'" placeholder="Enter your password" :autocomplete="mode === 'signin' ? 'current-password' : 'new-password'" size="lg" required :minlength="mode === 'signup' ? 8 : undefined" :disabled="busy || !ready">
            <template #trailing><UButton type="button" variant="link" color="neutral" :icon="showPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'" :aria-label="showPassword ? 'Hide password' : 'Show password'" :aria-pressed="showPassword" @click="showPassword = !showPassword" /></template>
          </UInput>
        </UFormField>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <p v-if="notice" class="form-notice" role="status">{{ notice }}</p>
        <UButton block type="submit" size="lg" :loading="busy" :disabled="!ready">{{ mode === 'signin' ? 'Sign in' : 'Create account' }}</UButton>
      </form>
      <p class="account-toggle">{{ mode === 'signin' ? 'New here?' : 'Already have an account?' }} <button type="button" :disabled="busy" @click="changeMode">{{ mode === 'signin' ? 'Create an account' : 'Sign in' }}</button></p>
    </template>
    <p v-if="user && error" class="form-error" role="alert">{{ error }}</p>
    <p class="auth-provider"><UIcon name="i-lucide-lock-keyhole" />Authentication by Supabase</p>
  </section>
</template>
