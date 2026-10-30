import type { Website } from './websites'
import type { SyncStatus } from './sync'
export type GoogleReport = {
  metricHeaders?: { name: string; type?: string }[]
  dimensionHeaders?: { name: string }[]
  rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[]
  rowCount?: number
  metadata?: { timeZone?: string; currencyCode?: string; subjectToThresholding?: boolean; dataLossFromOtherRow?: boolean; samplingMetadatas?: unknown[] }
}
export type DashboardReport = {
  sync?: SyncStatus
  website: Website; property_id: string; start_date: string; end_date: string
  report: Record<'summary' | 'daily' | 'pages' | 'channels' | 'devices', GoogleReport>
}
