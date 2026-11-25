import { scanTag } from './html-tag.js';

const SYNTAX =
  /<(?:style|link)(?=[\t\n\f\r />])|<\/style[\t\n\f\r />]|<\?xml-stylesheet|hidden|display|\ball(?=\s*(?::|\/\*))|@import|[<&\\]/gi;

/**
 * Whether a style sheet might show hidden content again: a `<style>` that sets what decides it
 * (`display`, `hidden`, `all`, `@import`) or could spell that in another way, or a linked style
 * sheet, which is not read. Looks at the source text, comments and scripts included, so it errs
 * towards yes. Linear: a tag it reads holds no other "<".
 */
export function styleSheetMayShowHidden(html: string): boolean {
  let inStyle = false;
  const syntax = new RegExp(SYNTAX);
  for (let match = syntax.exec(html); match; match = syntax.exec(html)) {
    const token = match[0].toLowerCase();
    if (token.startsWith('</style')) {
      inStyle = false;
    } else if (inStyle || token === '<?xml-stylesheet') {
      return true;
    } else if (token === '<style' || token === '<link') {
      const tag = scanTag(html, match.index + 1);
      if (!tag || tag.hasAngleBracket) return true;
      if (token === '<link' && /stylesheet|&/i.test(tag.rel ?? '')) return true;
      inStyle = token === '<style';
      syntax.lastIndex = tag.end;
    }
  }
  return false;
}
