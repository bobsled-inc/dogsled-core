import { SEARCH_ONLY_QUERY_SOURCE_CAPABILITIES, makeQuerySource } from './make-query-source.js';

export interface JiraIssue {
  id?: string | null;
  key?: string | null;
  self?: string | null;
  summary?: string | null;
  status_id?: string | null;
  status_name?: string | null;
  status_category_key?: string | null;
  issue_type_id?: string | null;
  issue_type_name?: string | null;
  project_id?: string | null;
  project_key?: string | null;
  project_name?: string | null;
  priority_id?: string | null;
  priority_name?: string | null;
  assignee_account_id?: string | null;
  assignee_display_name?: string | null;
  reporter_account_id?: string | null;
  reporter_display_name?: string | null;
  creator_account_id?: string | null;
  creator_display_name?: string | null;
  resolution_name?: string | null;
  labels?: unknown[] | null;
  components?: unknown[] | null;
  fix_versions?: unknown[] | null;
  created?: string | null;
  updated?: string | null;
  resolution_date?: string | null;
  due_date?: string | null;
  parent_id?: string | null;
  parent_key?: string | null;
  time_estimate?: number | null;
  aggregate_time_estimate?: number | null;
  time_spent?: number | null;
  subtasks?: unknown[] | null;
}

export interface JiraSearchIssuesInput {
  start_at?: number;
  max_results?: number;
  fields?: string[];
  expand?: string;
  fields_by_keys?: boolean;
  properties?: string[];
  validate_query?: 'strict' | 'warn' | 'none';
}

export const searchIssues = makeQuerySource<JiraIssue, JiraSearchIssuesInput>(
  'jira',
  'search_issues',
  SEARCH_ONLY_QUERY_SOURCE_CAPABILITIES
);
