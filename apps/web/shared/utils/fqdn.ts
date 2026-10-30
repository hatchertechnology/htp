export const FQDN_ERROR = 'Enter a full domain name such as www.example.com, without a scheme, port, or path.'

export function normalizeFqdn(input: string): string | null {
  const trimmed = input.trim()
  const value = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed
  if (!value || value.length > 1024 || /[\\/:@?#%\s]/u.test(value)) return null
  try {
    const name = new URL(`https://${value}`).hostname.toLowerCase()
    const labels = name.split('.')
    if (name.length > 253 || labels.length < 2 || !/[a-z]/.test(labels.at(-1)!)) return null
    if (labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null
    return name
  } catch { return null }
}
