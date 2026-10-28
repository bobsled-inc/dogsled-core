import {
  FILTER_ONLY_QUERY_SOURCE_CAPABILITIES,
  makeQuerySource,
  type MongoEqFilter,
} from './make-query-source.js';

export interface GithubBranch {
  name?: string | null;
  commit_sha?: string | null;
  commit_url?: string | null;
  protected?: boolean | null;
  protection_url?: string | null;
}

export interface GithubBranchesInput {
  owner?: string;
  repo?: string;
  per_page?: number;
}

export interface GithubBranchesFilter {
  protected?: MongoEqFilter<boolean>;
}

export const branches = makeQuerySource<GithubBranch, GithubBranchesInput, GithubBranchesFilter>(
  'github',
  'branches',
  FILTER_ONLY_QUERY_SOURCE_CAPABILITIES
);
