import type { SyncStatus } from './sync'
export type BingRow = Record<string, unknown>
export interface BingSection { rows: BingRow[] | null; error: string | null }
export interface BingReport {
  sites: { Url: string; IsVerified: boolean }[]
  site_url: string | null
  sections: Partial<Record<'traffic' | 'queries' | 'pages' | 'crawl' | 'issues' | 'sitemaps', BingSection>>
  sync?: SyncStatus
}
