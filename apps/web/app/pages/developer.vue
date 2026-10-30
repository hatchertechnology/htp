<script setup lang="ts">
useHead({ title: 'Hatch · API playground' })
</script>

<template>
  <div><div class="page-heading"><h1>A simple hello. A real connection.</h1><p>Explore the API, inspect responses, and make authenticated requests.</p></div><ExplorerTabs /><ApiExplorer transport="rest" /><ConnectBanner /></div>
</template>
