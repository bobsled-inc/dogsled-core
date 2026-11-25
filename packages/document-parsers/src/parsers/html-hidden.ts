/**
 * Removes the content of plainly hidden elements: a few container elements with the
 * `hidden` attribute or inline `display: none`.
 *
 * Not a browser. It removes an element only when its subtree is strictly balanced and holds
 * nothing that a browser could end early, move or read in another way, and keeps the text in
 * every other case. One pass, linear, with a capped stack; untrusted input.
 */

import { scanTag, type Tag } from './html-tag.js';

export interface VisibleHtml {
  readonly html: string;
  /** Characters of HTML source removed, tags included. */
  readonly removedCharacters: number;
}

const MAX_DEPTH = 256;
const MAY_HIDE_CONTENT = /hidden|display/i;
/** A document that declares this writes empty prefixed elements in XML style, as `<a:b/>`. */
const XBRL_NAMESPACE = 'http://www.xbrl.org/2013/inlineXBRL';

const names = (list: string): ReadonlySet<string> => new Set(list.split(' '));

const CONTAINERS = names('article aside div figure footer header main nav section span');

/**
 * What a removed element may hold. These cannot end an element around them: `BLOCKS` end only
 * an open paragraph, which the block containers do themselves. Table parts, forms, buttons
 * and others can, so an element that holds one keeps its text.
 */
const BLOCKS = names(
  'address article aside blockquote center dd div dl dt figure footer h1 h2 h3 h4 h5 h6 header ' +
    'li main nav ol p pre section ul'
);
const INLINES = names(
  'abbr b big cite code em font i label mark q s small span strong sub sup time u'
);
const VOIDS = names('br img wbr');
const LISTS = new Map([
  ['li', names('ol ul')],
  ['dd', names('dl')],
  ['dt', names('dl')],
]);

/** Elements in which a tag means something else. Nothing inside them is removed. */
const SEALED = names('math select svg template');
const RAW_TEXT = names('iframe noembed noframes textarea title xmp');
/** Elements whose text the tag stripper skips, and that a browser does not show. */
const SKIPPED = /\s*(script|style|noscript)\b/iy;
/** Inside `svg` or `math`, elements in which HTML rules apply again. */
const HTML_IN_FOREIGN = names('annotation-xml desc foreignobject mi mn mo ms mtext');

interface Candidate {
  readonly name: string;
  readonly start: number;
  readonly inline: boolean;
  /** Open elements, from the candidate itself. */
  readonly stack: string[];
  /** The open kinds that do not nest: a browser ends an open heading or link at the next one. */
  readonly unnestable: Set<string>;
}

export function removeHiddenContent(input: string): VisibleHtml {
  if (!MAY_HIDE_CONTENT.test(input)) return { html: input, removedCharacters: 0 };

  const output: string[] = [];
  let copied = 0;
  let removedCharacters = 0;
  let xbrl = false;
  let candidate: Candidate | null = null;
  let sealed: string | null = null;
  let cursor = 0;

  // Each `break` is a document read differently by a browser, or unclear: remove nothing more.
  for (;;) {
    const start = input.indexOf('<', cursor);
    if (start < 0) break;
    const isEndTag = input[start + 1] === '/';
    const nameStart = start + (isEndTag ? 2 : 1);

    SKIPPED.lastIndex = start + 1;
    const skipped = SKIPPED.exec(input)?.[1];
    if (skipped || input.startsWith('<!--', start)) {
      candidate = null;
      const end = skipped ? skippedEnd(input, start, skipped) : commentEnd(input, start);
      if (end < 0 || (skipped && sealed)) break;
      cursor = end;
      continue;
    }
    if (!isAsciiLetter(input.charCodeAt(nameStart))) {
      if (isEndTag || input[start + 1] === '!' || input[start + 1] === '?') {
        candidate = null;
        const end = input.indexOf('>', nameStart);
        if (end < 0 || (sealed && input.startsWith('<![CDATA[', start))) break;
        cursor = end + 1;
      } else {
        cursor = start + 1;
      }
      continue;
    }

    const tag = scanTag(input, nameStart);
    if (!tag) break;
    cursor = tag.end;
    const { name } = tag;
    if (tag.xbrlNamespace === XBRL_NAMESPACE) xbrl = true;

    if (candidate) {
      const state = isEndTag ? endInside(candidate, name) : startInside(candidate, tag, xbrl);
      if (state === 'open') continue;
      if (state === 'closed' && !input.slice(candidate.start, start).includes('-->')) {
        // Keep an empty element, so the text on both sides stays separate.
        output.push(input.slice(copied, candidate.start), `<${candidate.name}> `);
        removedCharacters += start - candidate.start;
        copied = start;
      }
      candidate = null;
      if (state === 'closed') continue;
    }

    if (sealed) {
      if (isEndTag) {
        if (name === sealed) sealed = null;
        continue;
      }
      if (SEALED.has(name) || RAW_TEXT.has(name) || HTML_IN_FOREIGN.has(name)) break;
    }
    if (isEndTag) continue;
    if (name === 'plaintext' || name === 'frameset') break;
    if (SEALED.has(name)) {
      const empty = tag.selfClosing && (name === 'svg' || name === 'math');
      if (!empty) sealed = name;
    } else if (RAW_TEXT.has(name)) {
      cursor = browserRawTextEnd(input, name, cursor);
      if (cursor < 0) break;
    } else if (!sealed && isCandidate(tag)) {
      const inline = name === 'span';
      candidate = { name, start, inline, stack: [name], unnestable: new Set() };
    }
  }
  if (removedCharacters === 0) return { html: input, removedCharacters };
  output.push(input.slice(copied));
  return { html: output.join(''), removedCharacters };
}

type CandidateState = 'open' | 'closed' | 'abandoned';

function endInside({ stack, unnestable }: Candidate, name: string): CandidateState {
  if (stack.pop() !== name) return 'abandoned';
  const kind = unnestableKind(name);
  if (kind) unnestable.delete(kind);
  return stack.length === 0 ? 'closed' : 'open';
}

function startInside(candidate: Candidate, tag: Tag, xbrl: boolean): CandidateState {
  const { stack, inline, unnestable } = candidate;
  const { name } = tag;
  if (tag.hasAngleBracket) return 'abandoned';
  if (VOIDS.has(name)) return 'open';
  const prefixed = name.includes(':');
  if (tag.selfClosing) return prefixed && xbrl ? 'open' : 'abandoned';

  const parent = stack.at(-1)!;
  const block = BLOCKS.has(name) && !inline;
  const link = name === 'a' && !inline;
  if (!block && !link && !prefixed && !INLINES.has(name)) return 'abandoned';
  if (LISTS.has(name) && !LISTS.get(name)!.has(parent)) return 'abandoned';
  const kind = unnestableKind(name);
  if ((kind && unnestable.has(kind)) || stack.length >= MAX_DEPTH) return 'abandoned';
  if (kind) unnestable.add(kind);
  stack.push(name);
  return 'open';
}

function isCandidate(tag: Tag): boolean {
  if (tag.selfClosing || tag.hasAngleBracket) return false;
  if (!CONTAINERS.has(tag.name)) return false;
  const hidden =
    tag.hidden !== null && !tag.hidden.includes('&') && tag.hidden.toLowerCase() !== 'until-found';
  return tag.style === null ? hidden : styleHides(tag.style, hidden);
}

/**
 * Whether a plain inline style hides its element, given whether the `hidden` attribute does.
 * A style that is not plain, or sets another `display`, might show the element.
 */
function styleHides(style: string, hidden: boolean): boolean {
  if (/[\\&()[\]{}"'@]|\/\*/.test(style)) return false;
  let hides = hidden;
  for (const declaration of style.toLowerCase().split(';')) {
    const colon = declaration.indexOf(':');
    const property = trimCssSpace(declaration.slice(0, Math.max(0, colon)));
    if (property === 'all') return false;
    if (property !== 'display') continue;
    const value = trimCssSpace(declaration.slice(colon + 1));
    if (!/^none(?:[ \t\n\f\r]*![ \t\n\f\r]*important)?$/.test(value)) return false;
    hides = true;
  }
  return hides;
}

/** CSS trims ASCII space only: another space character is part of a name. */
function trimCssSpace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isCssSpace(value[start]!)) start++;
  while (end > start && isCssSpace(value[end - 1]!)) end--;
  return value.slice(start, end);
}

function isCssSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\f' || char === '\r';
}

/** Where a comment ends, or -1 when a browser and the tag stripper disagree about it. */
function commentEnd(input: string, start: number): number {
  const contentStart = start + 4;
  const end = input.indexOf('-->', contentStart);
  if (end < 0) return -1;
  const content = input.slice(contentStart, end);
  const differs = content.startsWith('>') || content.startsWith('->') || content.includes('--!>');
  return differs ? -1 : end + 3;
}

/** Where a script, style or noscript ends, or -1 when a browser and the stripper disagree. */
function skippedEnd(input: string, start: number, name: string): number {
  const tag = scanTag(input, start + 1);
  if (!tag || tag.name !== name.toLowerCase()) return -1;
  if (input.indexOf('>', start) + 1 !== tag.end) return -1;
  const close = findClose(input, new RegExp(`</${name}[\\s>]`, 'gi'), tag.end);
  if (close < 0 || close !== browserRawTextEnd(input, tag.name, tag.end)) return -1;
  // A script inside an HTML comment inside a script does not end at the first close tag.
  const comment = input.slice(tag.end, close).indexOf('<!--');
  if (comment >= 0 && /<script/i.test(input.slice(tag.end + comment, close))) return -1;
  const closeTag = scanTag(input, close + 2);
  return closeTag && input.indexOf('>', close) + 1 === closeTag.end ? closeTag.end : -1;
}

function browserRawTextEnd(input: string, name: string, from: number): number {
  return findClose(input, new RegExp(`</${name}[\\t\\n\\f\\r />]`, 'gi'), from);
}

function findClose(input: string, close: RegExp, from: number): number {
  close.lastIndex = from;
  return close.exec(input)?.index ?? -1;
}

function unnestableKind(name: string): string | null {
  if (name === 'a') return 'link';
  return /^h[1-6]$/.test(name) ? 'heading' : null;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}
