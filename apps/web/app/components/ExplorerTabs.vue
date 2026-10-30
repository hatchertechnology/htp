<template>
  <nav class="explorer-tabs" aria-label="API interface">
    <NuxtLink to="/developer" :class="{ selected: $route.path === '/developer' }">REST API</NuxtLink>
    <NuxtLink to="/mcp" :class="{ selected: $route.path === '/mcp' }">MCP tools</NuxtLink>
  </nav>
</template>
