export function sampledUrl(input: string, fqdn: string): string | null {
  try {
    const url = new URL(input, `https://${fqdn}/`)
    if (url.protocol !== 'https:' || url.hostname !== fqdn || url.port || url.username || url.password || url.hash || input.includes('#') || input.includes('\\') || url.href.includes('|')) return null
    return url.href.length <= 2040 ? url.href : null
  } catch { return null }
}

export function performanceSource(device: string, url: string): string {
  return url ? `${device}|${url}` : device
}

// Unknown is not zero, and malformed values must never receive a "Good" label.
export function vitalValue(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return null
  const result = Number(value)
  return Number.isFinite(result) && result >= 0 ? result : null
}
