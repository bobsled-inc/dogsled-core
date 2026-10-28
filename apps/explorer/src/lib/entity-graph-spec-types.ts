export const ALLOWED_SPEC_TYPES = ['resolution', 'survivorship'] as const;

export type AllowedSpecType = (typeof ALLOWED_SPEC_TYPES)[number];

export function isAllowedSpecType(value: unknown): value is AllowedSpecType {
  return typeof value === 'string' && (ALLOWED_SPEC_TYPES as readonly string[]).includes(value);
}
