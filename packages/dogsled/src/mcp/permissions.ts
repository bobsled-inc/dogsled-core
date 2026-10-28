export interface Principal {
  principal_id: string;
  groups?: string[];
  capabilities?: string[];
}

export type PermissionMetadata =
  | { enforced: false; reason: 'no_adapter_registered' | 'adapter_does_not_apply' }
  | { enforced: true; adapter: string };

export interface PermissionAdapter {
  name: string;
  appliesTo(input: { sourceTable: string; principal: Principal }): boolean;
  filter<R>(rows: R[], context: { principal: Principal }): Promise<R[]>;
}
