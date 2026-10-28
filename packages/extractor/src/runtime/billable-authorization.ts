import type { BillableResourceBilling, ResourceSpec } from '../types/index.js';

export interface BillableResourceAuthorizationContext {
  operation: 'lookup' | 'query';
  resource: ResourceSpec;
  billing: BillableResourceBilling;
  /** Maximum number of upstream requests this call may make. */
  maxNetworkRequests?: number;
}

export type AuthorizeBillableResource = (
  context: BillableResourceAuthorizationContext
) => boolean | Promise<boolean>;
