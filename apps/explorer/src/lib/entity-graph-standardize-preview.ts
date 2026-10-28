export interface StandardizePreviewStep {
  transform: string;
  output: string;
  supported: boolean;
}

export interface StandardizePreviewResult {
  output: string;
  steps: StandardizePreviewStep[];
  unsupportedTransforms: string[];
}

const LEGAL_SUFFIXES_RE = /(?:,\s*)?(?:LLC|INC|CORP|LTD|CO|LP|PLC)\.?\s*$/i;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ');
}

function stripLegalSuffixes(value: string): string {
  return collapseWhitespace(value.replace(LEGAL_SUFFIXES_RE, '')).trim();
}

function stripProtocol(value: string): string {
  return value.replace(/^https?:\/\//i, '');
}

function stripWww(value: string): string {
  return value.replace(/^www\./i, '');
}

function stripCountryCode(value: string): string {
  // Only strip leading 1–3 digits when an explicit international marker is
  // present (`+` or `00`). Otherwise a domestic number like `3125550199`
  // would preview as `5550199`, which is wrong.
  const trimmed = value.trim();
  if (/^\+/.test(trimmed)) {
    return trimmed.replace(/^\+[0-9]{1,3}[\s-]?/, '');
  }
  if (/^00/.test(trimmed)) {
    return trimmed.replace(/^00[0-9]{1,3}[\s-]?/, '');
  }
  return trimmed;
}

function removePunctuation(value: string): string {
  return value.replace(/[^a-zA-Z0-9\s]/g, '');
}

export function applyStandardizeTransform(
  value: string,
  transform: string
): {
  output: string;
  supported: boolean;
} {
  switch (transform) {
    case 'lowercase':
      return { output: value.toLowerCase(), supported: true };
    case 'uppercase':
      return { output: value.toUpperCase(), supported: true };
    case 'trim':
      return { output: value.trim(), supported: true };
    case 'collapse_whitespace':
      return { output: collapseWhitespace(value), supported: true };
    case 'strip_legal_suffixes':
      return { output: stripLegalSuffixes(value), supported: true };
    case 'strip_www':
      return { output: stripWww(value), supported: true };
    case 'strip_protocol':
      return { output: stripProtocol(value), supported: true };
    case 'digits_only':
      return { output: value.replace(/[^0-9]/g, ''), supported: true };
    case 'strip_country_code':
      return { output: stripCountryCode(value), supported: true };
    case 'remove_punctuation':
      return { output: removePunctuation(value), supported: true };
    default:
      return { output: value, supported: false };
  }
}

export function previewStandardizeTransforms(
  input: string,
  transforms: string[]
): StandardizePreviewResult {
  let output = input;
  const steps: StandardizePreviewStep[] = [];
  const unsupportedTransforms: string[] = [];

  for (const transform of transforms) {
    const next = applyStandardizeTransform(output, transform);
    output = next.output;
    steps.push({
      transform,
      output,
      supported: next.supported,
    });
    if (!next.supported) {
      unsupportedTransforms.push(transform);
    }
  }

  return { output, steps, unsupportedTransforms };
}
