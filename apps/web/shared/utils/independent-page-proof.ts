/** Prove the contract describes every raw entity and every non-resource title outcome. */
export function provePagePopulation(
  pages: Array<{ url: string; is_resource?: boolean }> | undefined,
  contract: { coverage?: Array<{ rule?: string; entities?: number }>; observations?: Array<{entity_id?: string; source_locator?: string}>; omitted_observations?: number; truncated?: boolean } | undefined,
  evaluations: Map<string, { outcome?: string }>, duplicates: Set<string>, compatible: boolean,
  entityId: (url: string, resource: boolean) => string,
): boolean {
  const coverage = Array.isArray(contract?.coverage) ? contract.coverage.filter(c => c && c.rule === 'missing_title') : []
  if (!compatible || !Array.isArray(pages) || coverage?.length !== 1 || !Number.isSafeInteger(coverage[0]?.entities)
    || coverage[0]?.entities !== pages.length || !Array.isArray(contract?.observations)
    || !Number.isSafeInteger(contract.omitted_observations) || contract.omitted_observations! < 0
    || contract.observations.length + contract.omitted_observations! !== pages.length
    || (contract.omitted_observations !== 0 && contract.truncated !== true)) return false
  const seenIndices = new Set<number>()
  for (const observation of contract.observations) {
    const match = /^\/pages\/(0|[1-9][0-9]*)$/.exec(observation?.source_locator || '')
    const index = match ? Number(match[1]) : -1
    const page = pages[index]
    if (!Number.isSafeInteger(index) || index < 0 || !page || typeof page.url !== 'string'
      || typeof page.is_resource !== 'boolean' || seenIndices.has(index)
      || observation.entity_id !== entityId(page.url, page.is_resource)) return false
    seenIndices.add(index)
  }
  const urls = new Set<string>()
  for (const page of pages) {
    if (!page || typeof page.url !== 'string' || !page.url || typeof page.is_resource !== 'boolean' || urls.has(page.url)) return false
    urls.add(page.url)
    if (!page.is_resource) {
      const key = JSON.stringify([entityId(page.url, false), 'missing_title'])
      if (duplicates.has(key) || !['pass', 'fail', 'not_applicable'].includes(evaluations.get(key)?.outcome || '')) return false
    }
  }
  return true
}
