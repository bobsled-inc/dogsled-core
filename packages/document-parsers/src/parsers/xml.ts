export function decodeXmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) =>
      safeCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_match, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_match, name: string) => {
      switch (name) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default:
          return _match as string;
      }
    });
}

export function normalizeExtractedText(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractWordXmlText(xml: string): string {
  const out: string[] = [];
  const tokenRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<\/w:p>/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(xml)) !== null) {
    const [token, textNode] = match;
    if (textNode !== undefined) {
      out.push(decodeXmlEntities(textNode));
    } else if (token.startsWith('<w:tab')) {
      out.push('\t');
    } else {
      out.push('\n');
    }
  }
  return normalizeExtractedText(out.join(''));
}

export function extractDrawingXmlText(xml: string): string {
  const out: string[] = [];
  const textRe = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
  let match: RegExpExecArray | null;
  while ((match = textRe.exec(xml)) !== null) {
    if (match[1] !== undefined) {
      out.push(decodeXmlEntities(match[1]));
    }
  }
  return normalizeExtractedText(out.join(' '));
}

function safeCodePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) {
    return '';
  }
  return String.fromCodePoint(value);
}
