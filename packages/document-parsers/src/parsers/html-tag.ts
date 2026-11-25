/** The parts of a tag that decide whether its element is hidden. Values are not decoded. */
export interface Tag {
  readonly name: string;
  /** Position after the ">". */
  readonly end: number;
  readonly selfClosing: boolean;
  /** An attribute holds "<" or ">", so text scanning could see a tag in it. */
  readonly hasAngleBracket: boolean;
  readonly hidden: string | null;
  readonly style: string | null;
  /** The value of `xmlns:ix`. */
  readonly xbrlNamespace: string | null;
}

/** Read a tag from its name to its ">", or return null when the input ends first. */
export function scanTag(input: string, nameStart: number): Tag | null {
  let pos = nameStart;
  while (pos < input.length && !isNameEnd(input.charCodeAt(pos))) pos++;
  const name = input.slice(nameStart, pos).toLowerCase();
  const attributesStart = pos;
  let hidden: string | null = null;
  let style: string | null = null;
  let xbrlNamespace: string | null = null;

  while (pos < input.length) {
    const code = input.charCodeAt(pos);
    const selfClosing = code === SLASH && input.charCodeAt(pos + 1) === GREATER_THAN;
    if (code === GREATER_THAN || selfClosing) {
      const attributes = input.slice(attributesStart, pos);
      const hasAngleBracket = /[<>]/.test(attributes) || name.includes('<');
      const end = pos + (selfClosing ? 2 : 1);
      return { name, end, selfClosing, hasAngleBracket, hidden, style, xbrlNamespace };
    }
    if (code === SLASH || isSpace(code)) {
      pos++;
      continue;
    }
    const attributeStart = pos++;
    while (pos < input.length && input[pos] !== '=' && !isNameEnd(input.charCodeAt(pos))) pos++;
    const attribute = input.slice(attributeStart, pos).toLowerCase();
    while (isSpace(input.charCodeAt(pos))) pos++;
    let value = '';
    if (input[pos] === '=') {
      pos++;
      while (isSpace(input.charCodeAt(pos))) pos++;
      const quote = input[pos];
      if (quote === '"' || quote === "'") {
        const close = input.indexOf(quote, pos + 1);
        if (close < 0) return null;
        value = input.slice(pos + 1, close);
        pos = close + 1;
      } else {
        const valueStart = pos;
        while (pos < input.length && !isValueEnd(input.charCodeAt(pos))) pos++;
        value = input.slice(valueStart, pos);
      }
    }
    // The first attribute of a name wins, as in a browser.
    if (attribute === 'hidden') hidden ??= value;
    else if (attribute === 'style') style ??= value;
    else if (attribute === 'xmlns:ix') xbrlNamespace ??= value;
  }
  return null;
}

const GREATER_THAN = 0x3e;
const SLASH = 0x2f;

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

function isNameEnd(code: number): boolean {
  return isSpace(code) || code === SLASH || code === GREATER_THAN;
}

function isValueEnd(code: number): boolean {
  return isSpace(code) || code === GREATER_THAN;
}
