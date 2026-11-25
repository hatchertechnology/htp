<template>
  <div class="public-shell">
    <header class="public-topbar">
      <NuxtLink to="/" class="public-brand" aria-label="Hatch home">Hatch<span class="brand-stop">.</span></NuxtLink>
    </header>
    <main id="main-content" class="public-main"><slot /></main>
  </div>
</template>
