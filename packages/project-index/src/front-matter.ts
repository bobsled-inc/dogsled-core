/**
 * Markdown front matter helpers shared by the index and the Project Skill and
 * guide parsers. Front matter is a block delimited by lines containing only
 * `---` at the very start of the document.
 */

export interface FrontMatterSplit {
  frontMatter: string;
  body: string;
}

export const FRONT_MATTER_PATTERN = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/;

const BYTE_ORDER_MARK = '\uFEFF';

export function stripByteOrderMark(text: string): string {
  return text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
}

export function normalizeDocumentText(raw: string): string {
  return stripByteOrderMark(raw).replace(/\r\n?/g, '\n');
}

export function splitFrontMatter(normalized: string): FrontMatterSplit | undefined {
  const match = FRONT_MATTER_PATTERN.exec(normalized);
  if (!match) return undefined;
  return { frontMatter: match[1] ?? '', body: match[2] ?? '' };
}
