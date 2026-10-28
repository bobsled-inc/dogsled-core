import {
  FILTER_ONLY_QUERY_SOURCE_CAPABILITIES,
  makeQuerySource,
  type MongoEqFilter,
  type MongoGteFilter,
} from './make-query-source.js';

export interface GithubIssue {
  id?: number | null;
  node_id?: string | null;
  number?: number | null;
  title?: string | null;
  html_url?: string | null;
  url?: string | null;
  state?: 'open' | 'closed' | null;
  state_reason?: string | null;
  locked?: boolean | null;
  active_lock_reason?: string | null;
  user_login?: string | null;
  user_id?: number | null;
  assignee_login?: string | null;
  assignees_count?: number | null;
  labels?: string[] | null;
  milestone_title?: string | null;
  milestone_number?: number | null;
  reactions_total?: number | null;
  reactions_plus_one?: number | null;
  reactions_minus_one?: number | null;
  comments?: number | null;
  body?: string | null;
  author_association?: string | null;
  is_pull_request?: boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
  closed_at?: string | null;
}

export interface GithubIssuesInput {
  owner?: string;
  repo?: string;
  sort?: 'created' | 'updated' | 'comments';
  direction?: 'asc' | 'desc';
  per_page?: number;
}

export interface GithubIssuesFilter {
  state?: MongoEqFilter<'open' | 'closed'>;
  updated_at?: MongoGteFilter<string>;
}

export const issues = makeQuerySource<GithubIssue, GithubIssuesInput, GithubIssuesFilter>(
  'github',
  'issues',
  FILTER_ONLY_QUERY_SOURCE_CAPABILITIES
);
