import {
  FILTER_ONLY_QUERY_SOURCE_CAPABILITIES,
  makeQuerySource,
  type MongoEqFilter,
} from './make-query-source.js';

export type GithubPullRequestState = 'open' | 'closed' | 'all';

export interface GithubPullRequest {
  id?: number | null;
  node_id?: string | null;
  number?: number | null;
  title?: string | null;
  html_url?: string | null;
  diff_url?: string | null;
  patch_url?: string | null;
  state?: 'open' | 'closed' | null;
  locked?: boolean | null;
  draft?: boolean | null;
  user_login?: string | null;
  user_id?: number | null;
  author_association?: string | null;
  assignee_login?: string | null;
  labels?: string | null;
  milestone_title?: string | null;
  head_ref?: string | null;
  head_sha?: string | null;
  head_repo_full_name?: string | null;
  base_ref?: string | null;
  base_sha?: string | null;
  merged?: boolean | null;
  mergeable?: boolean | null;
  merge_commit_sha?: string | null;
  merged_by_login?: string | null;
  requested_reviewers?: string | null;
  body?: string | null;
  comments?: number | null;
  review_comments?: number | null;
  commits?: number | null;
  additions?: number | null;
  deletions?: number | null;
  changed_files?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  closed_at?: string | null;
  merged_at?: string | null;
}

export interface GithubPullRequestsInput {
  owner: string;
  repo: string;
  sort?: 'created' | 'updated' | 'popularity' | 'long-running';
  direction?: 'asc' | 'desc';
  per_page?: number;
}

export interface GithubPullRequestsFilter {
  state?: MongoEqFilter<GithubPullRequestState>;
}

export const pullRequests = makeQuerySource<
  GithubPullRequest,
  GithubPullRequestsInput,
  GithubPullRequestsFilter
>('github', 'pull_requests', FILTER_ONLY_QUERY_SOURCE_CAPABILITIES);
