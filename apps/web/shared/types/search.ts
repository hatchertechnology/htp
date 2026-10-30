import type { SyncStatus } from './sync'
export interface SearchRow { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }
export interface SearchRows { rows?: SearchRow[] }
export interface SearchReport { sync?: SyncStatus; site_url: string; start_date: string; end_date: string; summary: SearchRows; daily: SearchRows; queries: SearchRows; pages: SearchRows }
export interface SearchProperty { siteUrl: string; permissionLevel: string }
export interface Inspection { inspectionResult?: { inspectionResultLink?: string; indexStatusResult?: { verdict?: string; coverageState?: string; robotsTxtState?: string; indexingState?: string; lastCrawlTime?: string; pageFetchState?: string; googleCanonical?: string; userCanonical?: string }; mobileUsabilityResult?: { verdict?: string }; richResultsResult?: { verdict?: string } } }
