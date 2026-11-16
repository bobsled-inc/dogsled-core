export const STREAM_SUBFOLDER_MAX_LENGTH = 256;

const SEGMENT_PATTERN = /^[A-Za-z0-9._=-]+$/;

export const STREAM_SUBFOLDER_RULE =
  'Must be a relative folder path of up to 256 characters. Each segment holds letters, digits, dots, dashes, equals signs or underscores, and is not "." or ".."';

export function normalizeStreamSubfolder(value: string): string {
  return value.replace(/\/+$/, '');
}

export function isValidStreamSubfolder(value: string): boolean {
  if (value.length === 0 || value.length > STREAM_SUBFOLDER_MAX_LENGTH) {
    return false;
  }

  return value
    .split('/')
    .every((segment) => segment !== '.' && segment !== '..' && SEGMENT_PATTERN.test(segment));
}
