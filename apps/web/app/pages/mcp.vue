<script setup lang="ts">
useHead({ title: 'Hatch · MCP tools' })
</script>

<template>
  <div><div class="page-heading"><h1>Your API. In your tools.</h1><p>Discover and call MCP tools with the same Supabase session.</p></div><ExplorerTabs /><ApiExplorer transport="mcp" /><ConnectBanner /></div>
</template>
