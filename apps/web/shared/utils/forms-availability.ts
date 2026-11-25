// Which Forms surface (if any) the build enables. Mirrors the pre-existing page
// logic: the authenticated pilot wins over the legacy rollout flag.
export type FormsMode = 'pilot' | 'legacy'

export type FormsSurface = { enabled: false } | { enabled: true; mode: FormsMode }

export function formsSurface(cfg: { rolloutForms?: unknown; rolloutFormsPilot?: unknown } | null | undefined): FormsSurface {
  if (cfg?.rolloutFormsPilot === true) return { enabled: true, mode: 'pilot' }
  if (cfg?.rolloutForms === true) return { enabled: true, mode: 'legacy' }
  return { enabled: false }
}
