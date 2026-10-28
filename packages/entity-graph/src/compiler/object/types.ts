import type { ObjectActionRef, ObjectLinkDirection, ObjectSpec } from './schema.js';

export interface ParsedObjectSpec {
  name: string;
  filePath: string;
  raw: ObjectSpec;
}

export interface ResolvedObjectLink {
  relationRef: string;
  relationName: string;
  direction: ObjectLinkDirection;
}

export interface ResolvedObjectAction {
  actionRef: ObjectActionRef['action_ref'];
  label?: ObjectActionRef['label'];
}

export interface ResolvedObjectSpec {
  name: string;
  identityResolutionRef: string;
  links: ResolvedObjectLink[];
  actions: ResolvedObjectAction[];
}

export type { ObjectActionRef };
