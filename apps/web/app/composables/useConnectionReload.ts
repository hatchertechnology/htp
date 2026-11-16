// Keep reads independent of connection readiness, while retrying when the
// connection changes in a mounted dashboard.
export function useConnectionReload(source: () => readonly unknown[], reload: () => void) {
  watch(source, reload, { immediate: true })
}
