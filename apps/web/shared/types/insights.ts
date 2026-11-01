import type { GoogleReport } from './dashboard'
import type { SyncStatus } from './sync'
export type InsightKind = 'pagespeed' | 'crux' | 'conversions' | 'business_locations' | 'business_profile' | 'business_performance'
export interface SavedInsight<T> { data: T | null; sync: SyncStatus }
export interface ConversionData { summary: GoogleReport; daily: GoogleReport; pages: GoogleReport; channels: GoogleReport; events: GoogleReport }
export interface PerformanceMeasurement {
  semantics_version: 1; mode: 'lab' | 'field'; scope: 'url' | 'origin'; target: string; device: string
  sample_count?: number; metrics?: Record<string, number | null>
}
export interface PageSpeedData {
  measurement?: PerformanceMeasurement
  strategy: string; url: string; analysisUTCTimestamp?: string
  lighthouseResult: {
    fetchTime?: string; lighthouseVersion?: string; requestedUrl?: string; finalDisplayedUrl?: string; finalUrl?: string; environment?: Record<string, unknown>; configSettings?: Record<string, unknown>
    categories: Record<string, { title: string; score: number | null }>
    audits: Record<string, { title: string; description?: string; score: number | null; displayValue?: string; numericValue?: number; details?: unknown }>
  }
}
export interface CruxData {
  available: boolean; reason?: string; measurement?: PerformanceMeasurement; url?: string; origin?: string; formFactor?: string
  record?: { key?: { url?: string; origin?: string; formFactor?: string }; collectionPeriod: { firstDate: GoogleDate; lastDate: GoogleDate }; metrics: Record<string, { percentiles: { p75: number | string } }> }
}
export interface GoogleDate { year: number; month: number; day: number }
export interface BusinessLocation { name: string; title: string; websiteUri?: string; storefrontAddress?: { addressLines?: string[]; locality?: string } }
export interface BusinessPerformance {
  multiDailyMetricTimeSeries?: { dailyMetricTimeSeries?: { dailyMetric: string; timeSeries?: { datedValues?: { date: GoogleDate; value?: string }[] } }[] }[]
}
export interface ProfileChange { id: number; snapshot_id: number; previous_snapshot_id: number | null; observed_at: string; previous_observed_at: string | null; field: string; before_value: unknown; after_value: unknown }
export interface InsightHistory<T = unknown> { samples?: string[]; comparison?: { health?: { day: string; kind: string; data: { performance?: number | null; metrics?: Record<string, { percentiles: { p75: number | string } }> } }[]; analytics?: { daily: GoogleReport }; conversions?: ConversionData; search?: { daily?: { rows?: { keys: string[]; clicks: number; impressions: number }[] } }; business_performance?: BusinessPerformance }; snapshots: { id: number; fetched_at: string; data: T }[]; changes: ProfileChange[]; bindings: string[]; has_more: boolean; changes_truncated: boolean }
