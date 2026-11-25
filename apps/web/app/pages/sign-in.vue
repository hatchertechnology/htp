<script setup lang="ts">
useHead({ title: 'Hatch · Sign in' })
definePageMeta({ layout: 'public' })
</script>

<template>
  <section class="sign-in-panel surface" aria-labelledby="sign-in-heading">
    <h1 id="sign-in-heading">Sign in to Hatch</h1>
    <p class="sign-in-lede">Review your websites and their performance in one workspace.</p>
    <SignInForm />
  </section>
</template>
