export interface RepositoryBinding {
  id: string; repository_url: string; branch: string | null; enabled: boolean;
  attached_at: string; last_checked_at: string | null; last_error: string | null;
  next_run_at: string; backfilling: boolean;
}
export interface RepositoryCommit {
  id: number; sha: string; message: string; author: string | null;
  authored_at: string | null; committed_at: string; observed_at: string;
  repository_url: string; branch: string | null;
}
export interface RepositoryHistory { fqdn: string; repository: RepositoryBinding | null; commits: RepositoryCommit[]; has_more: boolean }
export interface RepositoryIssue {
  number: number; title: string; state: 'open' | 'closed'; url: string; updated_at: string;
}
export interface RepositoryIssues { repository_url: string | null; issues: RepositoryIssue[]; has_more: boolean }
