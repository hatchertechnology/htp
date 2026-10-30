export interface Website { id: string; fqdn: string; ga4_property_id?: string | null }
export interface WebsitePage { items: Website[]; has_more: boolean }
