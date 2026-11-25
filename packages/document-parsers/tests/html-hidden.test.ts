import { describe, expect, it } from 'vitest';

import { emailParser, htmlParser } from '../src/index.js';
import type { ParsedDocument } from '../src/index.js';
import { removeHiddenContent } from '../src/parsers/html-hidden.js';
import { extractHtmlText, htmlToText } from '../src/parsers/html.js';

const baseOpts = { sourceUri: 'file:test', contentHash: 'abc123' };
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const XBRL = '<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL">';

/** Text of `html` between two visible words, so that lost text on either side shows. */
const around = (html: string, prefix = ''): string =>
  htmlToText(`${prefix}before ${html} after`).replace(/\s+/g, ' ');

describe('hidden HTML content that is dropped', () => {
  it.each([
    ['the hidden attribute', '<div hidden>gone</div>'],
    ['an empty hidden value', '<div hidden="">gone</div>'],
    ['any other hidden value', '<div HIDDEN=false>gone</div>'],
    ['an inexact until-found', '<div hidden=" until-found ">gone</div>'],
    ['hidden after other attributes', `<div class="a" data-x='b' id=c hidden>gone</div>`],
    ['hidden after a slash', '<div/hidden>gone</div>'],
    ['hidden on a new line', '<div\n\thidden\n>gone</div >'],
    ['display none', '<div style="display:none">gone</div>'],
    ['display none in single quotes', "<div style='display:none;'>gone</div>"],
    ['an unquoted style', '<div style=display:none>gone</div>'],
    ['capitals and spaces', '<div STYLE=" COLOR : red ; DISPLAY\n:\tNone ; ">gone</div>'],
    ['important', '<div style="display:none!important">gone</div>'],
    ['spaced important', '<div style="display: none ! IMPORTANT;color:red">gone</div>'],
    ['display none twice', '<div style="display:none;display:none !important">gone</div>'],
    ['hidden and display none', '<div hidden style="display:none">gone</div>'],
    ['hidden and a plain style', '<div hidden style="color: red">gone</div>'],
    ['every container', containers().join('')],
    ['nested tags', '<div hidden><p>gone</p><ul><li>gone</li></ul><h2>gone</h2></div>'],
    ['the same name nested', '<div hidden><div>gone</div>gone<div>gone</div></div>'],
    ['hidden in hidden', '<div hidden>gone<div hidden>gone</div>gone</div>'],
    ['void elements and links', '<div hidden>gone<br>gone<img src=x><a href=y>gone</a></div>'],
    ['an inline element', '<span hidden>gone<b>gone</b><br></span>'],
    ['prefixed elements', '<div hidden><x:y>gone</x:y></div>'],
  ])('%s', (_name, html) => {
    expect(around(html)).toBe('before after');
  });

  it('a hidden container that wraps the header of an Inline XBRL report', () => {
    const header =
      '<div style="display:none"><ix:header><ix:references><link:schemaRef href="x"/>' +
      '</ix:references><ix:nonNumeric name="a">VIS</ix:nonNumeric></ix:header></div>';
    expect(around(header, XBRL)).toBe('before after');
    // XML-style empty elements need the namespace, declared as an attribute.
    for (const prefix of [
      '',
      '<!-- http://www.xbrl.org/2013/inlineXBRL -->',
      '<html xmlns:ix="x">',
    ]) {
      expect(around(header, prefix)).toContain('VIS');
    }
    expect(around('<ix:header>VIS</ix:header>', XBRL)).toContain('VIS');
  });

  it('keeps the text on both sides of a block separate', () => {
    expect(htmlToText('one<div hidden>x</div>two')).toBe('one\n\ntwo');
    expect(htmlToText('one<nav hidden>x</nav>two')).toBe('one two');
    expect(htmlToText('<p>one</p><div hidden>x</div><p>two</p>')).toBe('one\n\ntwo');
    expect(htmlToText('a < b <div hidden>x</div> c <p>d</p>')).toMatch(/c d$/);
  });

  it('leaves no space where a span was', () => {
    expect(htmlToText('<p>quar<span style="display:none">zzz</span>terly</p>')).toBe('quarterly');
    expect(htmlToText('pat<span style="display:none">x</span>@example.com')).toBe(
      'pat@example.com'
    );
    expect(htmlToText('a<span hidden>x</span><span hidden>y</span>b')).toBe('ab');
    expect(htmlToText('a<span hidden>x<b>y</b><br></span>b')).toBe('ab');
  });

  it('keeps the space that was around a span', () => {
    const hidden = '<span hidden>x</span>';
    expect(htmlToText(`one ${hidden}two`)).toBe('one two');
    expect(htmlToText(`one${hidden} two`)).toBe('one two');
    expect(htmlToText(`one ${hidden} two`)).toBe('one two');
    expect(htmlToText(`one\t${hidden}  two`)).toBe('one two');
    expect(htmlToText(`one ${hidden} ${hidden} two`)).toBe('one two');
    expect(htmlToText(`${hidden} one ${hidden}`)).toBe('one');
    // A line break on each side is one line break, not a blank line.
    expect(htmlToText(`one\n${hidden}\ntwo`)).toBe('one\ntwo');
  });

  function containers(): string[] {
    const names = 'div span section article aside header footer main nav figure';
    return names.split(' ').map((name) => `<${name} hidden>gone</${name}>`);
  }
});

describe('HTML content that is kept', () => {
  it.each([
    ['hidden until found', '<div hidden="until-found">VIS</div>'],
    ['hidden until found in capitals', '<div hidden=UNTIL-FOUND>VIS</div>'],
    ['hidden until found with an entity', '<div hidden="&#117;ntil-found">VIS</div>'],
    ['aria-hidden and similar names', '<div aria-hidden="true" data-hidden hidden-x>VIS</div>'],
    ['hidden as a value', '<div class="hidden" id=hidden title=" hidden ">VIS</div>'],
    ['a first hidden that shows', '<div hidden="until-found" hidden>VIS</div>'],
    ['another display', '<div style="display:block">VIS</div>'],
    ['a display starting with none', '<div style="display:none-ish">VIS</div>'],
    ['another property', '<div style="x-display:none;display-x:none;--display:none">VIS</div>'],
    ['a later display', '<div style="display:none;display:block">VIS</div>'],
    ['an earlier display', '<div style="display:block;display:none">VIS</div>'],
    ['another display over hidden', '<div hidden style="display:block">VIS</div>'],
    ['a style that is not plain over hidden', '<div hidden style="color:rgb(0,0,0)">VIS</div>'],
    ['a URL', '<div style="background:url(http://example.com/?a;display:none)">VIS</div>'],
    ['a string', `<div style="content:'x;display:none;y'">VIS</div>`],
    ['a CSS comment', '<div style="/* display:none; */">VIS</div>'],
    ['another attribute', '<div data-style="display:none" title="display:none">VIS</div>'],
    ['a first style that shows', '<div style="" style="display:none">VIS</div>'],
    ['a void element', '<br hidden><img style="display:none" src=x><input hidden>VIS'],
    ['a self-closing element', '<div hidden/>VIS</div>'],
    ['a hidden tag in an attribute', '<i title="<div hidden>">VIS</i></div>'],
    ['a hidden tag in text', '< div hidden >VIS</div>'],
    ['an element outside the list', '<p hidden>VIS</p><li hidden>VIS</li><x-y hidden>VIS</x-y>'],
    // Trees that a browser builds in another way than the tags suggest.
    ['a form in a form', '<form>a<form hidden>VIS</form>'],
    ['a link in a link', '<a hidden>x<a>VIS</a></a>'],
    ['a nobr in a nobr', '<nobr hidden>x<nobr>VIS</nobr></nobr>'],
    ['a heading in a heading', '<h1 hidden>x<h2>VIS</h2></h1>'],
    ['a heading closed by another', '<h1 hidden>x</h2>VIS</h1>'],
    ['a block moved out of a table', '<table hidden><div>VIS</div><tr><td>x</table>'],
    ['text moved out of a row', '<table><tr hidden>VIS<td>x</table>'],
    ['a cell outside a table', '<td hidden>VIS</td>'],
    ['a row outside a table', '<tr hidden>VIS</tr>'],
    ['a caption outside a table', '<caption hidden>VIS</caption>'],
    ['text in svg', '<svg><text hidden>VIS</text></svg>'],
    ['text in math', '<math><mtext hidden>VIS</mtext></math>'],
    ['CDATA in svg', '<svg><text><![CDATA[><text hidden>]]>VIS</text></svg>'],
    ['plaintext', '<plaintext><div hidden>VIS</div>'],
    ['a frameset', '<p>x<frameset hidden>VIS</frameset>'],
    ['a textarea that looks closed', '<textarea/><div hidden>VIS</div></textarea>'],
    ['a textarea', '<textarea hidden>x</textarea/>VIS<textarea></textarea>'],
    ['a select in a select', '<select hidden><option>x<select>VIS</select></select>'],
    ['a block in a select', '<select><div hidden>VIS</div></select>'],
    ['an input in a select', '<select hidden><option>x<input>VIS</select>'],
    ['a cell in a hidden block in a cell', '<table><td><div hidden><td>VIS</td></div></table>'],
    ['a table in a hidden block', '<table><div hidden><table>VIS</table></div></table>'],
    ['a block in a hidden span', '<p><span hidden><div>VIS</div></span></p>'],
    ['a link in a hidden span', '<a><span hidden><a>VIS</a></span></a>'],
    ['a button in a hidden block', '<button><div hidden><button>VIS</button></div></button>'],
    ['an item in a hidden block', '<ul><li><div hidden><li>VIS</li></div></ul>'],
    ['a term in a hidden block', '<dl><dt><div hidden><dd>VIS</dd></div></dl>'],
    ['headings', '<h3><div hidden><h1>a<h2>b</h2></h1>VIS</div></h3>'],
    [
      'a heading in a paragraph in a heading',
      '<h1><div hidden><h2><p><h3>a</h3></p></h2>VIS</div></h1>',
    ],
    ['a section in svg', '<svg><section hidden>VIS</section></svg>'],
    [
      'a section after HTML in svg',
      '<svg><foreignObject><p></svg></p></foreignObject><section hidden>VIS</section>',
    ],
    ['a section after text in svg', '<svg><title></svg></title><section hidden>VIS</section>'],
    ['svg in a comment that ends early', '<!--><svg><!-- --><section hidden>VIS</section></svg>'],
    ['svg after an odd comment end', '<!-- a --!><svg><!-- --><section hidden>VIS</section></svg>'],
    [
      'svg after an odd script end',
      '<script></script/><svg></script><section hidden>VIS</section></svg>',
    ],
    [
      'a script in a script',
      '<script><!-- <script></script> --></script><div hidden><td>VIS</div>',
    ],
    // Styles that a browser reads in another way than a plain list.
    ['an unmatched bracket', '<div style="x:(];display:none">VIS</div>'],
    ['the all property', '<div style="display:none;all:initial">VIS</div>'],
    ['a CSS escape', '<div style="display:none;dis\\70lay:block">VIS</div>'],
    ['an entity', '<div style="display:none;dis&#112;lay:block">VIS</div>'],
    ['a no-break space in a value', '<div style="display:\u00a0none">VIS</div>'],
    ['a no-break space in a property', '<div style="\u00a0display:none">VIS</div>'],
    // Content that ends what the tag stripper skips.
    ['the end of a comment', '<a title="><!--">q</a><div hidden>--></div>VIS'],
    ['the end of a script', '<a title="> <script ">q</a><div hidden></script ></div>VIS'],
    ['the end of a comment in a tag', '<a title="><!--">q</a><div hidden --></div>VIS'],
  ])('%s', (_name, html) => {
    expect(around(html)).toContain('VIS');
    expect(removeHiddenContent(`before ${html} after`).removedCharacters).toBe(0);
  });

  it.each([
    ['an unclosed element', '<div hidden>VIS<p>VIS</p>'],
    ['an element closed by its parent', '<section><div hidden>VIS</section><p>VIS</p>'],
    ['an unclosed element inside', '<div hidden><p>VIS</div>'],
    ['a stray end tag inside', '<div hidden>VIS</b></div>'],
    ['misnested tags inside', '<div hidden><b>VIS<i></b></i></div>'],
    ['a self-closing tag inside', '<div hidden><x-y/>VIS</div>'],
    ['a self-closing prefixed tag inside, without XBRL', '<div hidden><x:y/>VIS</div>'],
    ['a comment inside', '<div hidden>VIS<!-- c --></div>'],
    ['CDATA inside', '<div hidden>VIS<![CDATA[x]]></div>'],
    ['a script inside', '<div hidden>VIS<script>x</script></div>'],
    ['a style inside', '<div hidden>VIS<style>x</style></div>'],
    ['a noscript inside', '<div hidden>VIS<noscript>x</noscript></div>'],
    ['a textarea inside', '<div hidden>VIS<textarea>x</textarea></div>'],
    ['a table inside', '<div hidden><table><tr><td>VIS</td></tr></table></div>'],
    ['svg inside', '<div hidden>VIS<svg></svg></div>'],
    ['an angle bracket in an attribute', '<div hidden><i title="a > b">VIS</i></div>'],
    ['an angle bracket in its own attribute', '<div title="a > b" hidden>VIS</div>'],
    ['an unclosed quote', '<div hidden>VIS<i title="></div>'],
  ])('%s', (_name, html) => {
    expect(around(html)).toContain('VIS');
    expect(removeHiddenContent(html).removedCharacters).toBe(0);
  });

  it('goes on after an element it keeps', () => {
    expect(htmlToText('<div hidden>one<td></div><div hidden>x</div>two')).toMatch(/one\s+two/);
    expect(htmlToText('<svg><path/></svg><div hidden>x</div>one')).toBe('one');
    expect(htmlToText('<select><option>one</select><div hidden>x</div>two')).toMatch(/one\s+two/);
    expect(htmlToText('<title>one</title><script>a</script><div hidden>x</div>two')).toMatch(
      /one\s+two/
    );
  });

  it('keeps an element nested deeper than the cap', () => {
    const nested = (depth: number): string =>
      `<div hidden>${'<b>'.repeat(depth)}VIS${'</b>'.repeat(depth)}</div>after`;
    expect(htmlToText(nested(255))).toBe('after');
    expect(htmlToText(nested(256))).toContain('VIS');
    expect(htmlToText(`<div hidden>${'<b>'.repeat(100_000)}VIS</div>after`)).toContain('VIS');
  });

  it('never hides the whole document', () => {
    const html =
      '<html hidden><head hidden><title>Title</title></head>' +
      '<body style="display:none"><p>body</p></body></html>';
    expect(removeHiddenContent(html).removedCharacters).toBe(0);
  });

  it.each([
    ['the attribute', '<style>[hidden]{display:block}</style>'],
    ['a media query', '<style>@media (max-width:9px){.m{DISPLAY:block!important}}</style>'],
    ['every property', '<style>.m{all:unset!important}</style>'],
    ['every property, after a comment', '<style>.m{all/**/:unset!important}</style>'],
    ['an import', '<style>@import url(x.css);</style>'],
    ['an escape', '<style>.m{dis\\70lay:block!important}</style>'],
    ['an entity in svg', '<svg><style>.m{dis&#112;lay:block!important}</style></svg>'],
    [
      'a style that svg does not end',
      '<svg><style><![CDATA[</style >*{display:block}]]></style></svg>',
    ],
    [
      'a second style',
      '<style>p{color:red}</style><STYLE type="text/css">p{display:block}</STYLE>',
    ],
    ['a style that is not closed', '<style>*{display:block!important}'],
    ['a style in an odd comment', '<!--><style>*{display:block}</style>-->'],
    ['a close tag in an attribute', '<style title="</style >">*{display:block}</style>'],
    [
      'a style after a fake one',
      '<!-- <style title=" --><style>*{display:block}</style><i title="">',
    ],
    ['a linked style sheet', '<link rel="stylesheet" href="x.css">'],
    ['a linked style sheet in capitals', '<LINK href=x REL="alternate StyleSheet">'],
    ['a linked style sheet with an entity', '<link rel="&#115;tylesheet" href="x.css">'],
    ['a linked style sheet after a fake one', '<!-- <link a=" --><link rel=stylesheet><i b="">'],
    ['a style sheet instruction', '<?xml-stylesheet href="x.css"?>'],
  ])('everything when a style sheet might show it: %s', (_name, sheet) => {
    const hidden = '<div class=m hidden>VIS</div>';
    for (const html of [`${sheet}before ${hidden} after`, `before ${hidden} after${sheet}`]) {
      expect(removeHiddenContent(html)).toEqual({ html, removedCharacters: 0 });
    }
    expect(htmlToText(`before ${hidden} after${sheet}`)).toContain('VIS');
  });

  it.each([
    [
      'no display',
      '<style media="all" title="display">p{color:red;transition:all .3s}@media all{a{top:0}}</style>',
    ],
    ['an empty style', '<style></style>'],
    ['another link', '<link rel="icon" href="?display&hidden">'],
    ['a prefixed link', '<link:schemaRef rel="stylesheet"></link:schemaRef>'],
    ['the words outside a style', '<p>display hidden all: @import \\</p><style>p{top:0}</style>'],
  ])('only what is hidden with a style sheet that cannot show it: %s', (_name, sheet) => {
    expect(htmlToText(`before <div hidden>gone</div> after${sheet}`)).not.toContain('gone');
  });

  it('changes nothing in documents without hidden content', () => {
    const html =
      '<html><head><title>Plan</title><style>.hidden { display: none }</style></head><body>' +
      '<h1>H&amp;M</h1><p class="hidden">One<br>  two</p><a title="a > b">three</a>' +
      '<ul><li>four<li>five</ul><table><tr><td>six</td><td>seven</td></tr></table>' +
      '<!-- display --><script>hidden</script> 1 < 2 &nbsp; <p aria-hidden="true">eight';
    expect(removeHiddenContent(html)).toEqual({ html, removedCharacters: 0 });
    expect(htmlToText(html)).toBe('PlanH&M\n\nOne\ntwo\n\nb">threefourfivesixseven\n\n1 eight');
  });
});

describe('documents with only hidden content', () => {
  const page = '<div id="app" style="display:none"><p>whole page</p></div>';

  it('keep their text', () => {
    expect(extractHtmlText(page)).toEqual({ text: 'whole page', hiddenCharacters: 0 });
    expect(htmlToText(`<html><head><title>App &amp; co</title></head><body>${page}`)).toContain(
      'whole page'
    );
    expect(htmlToText(`&#8203;\u00ad\ufeff${page}`)).toContain('whole page');
    expect(htmlToText(`Loading ${page}`)).not.toContain('whole page');
    expect(htmlToText('<div hidden></div>')).toBe('');
  });

  it('parse the same way as HTML and as email', async () => {
    const html = (await htmlParser.parse(utf8(page), baseOpts)) as ParsedDocument;
    expect(html).toMatchObject({ text: 'whole page', metadata: { hiddenCharacters: 0 } });
    const eml = (await emailParser.parse(
      utf8(`Content-Type: text/html\n\n${page}`),
      baseOpts
    )) as ParsedDocument;
    expect(eml).toMatchObject({ text: 'whole page', metadata: { hiddenCharacters: 0 } });
  });
});

describe('parser results', () => {
  it('report the parser version and how much was dropped', async () => {
    const hidden = '<div style="display:none">preheader</div>';
    const metadata = { hiddenCharacters: hidden.length - '</div>'.length };
    const html = await htmlParser.parse(utf8(`${hidden}<p>Hello</p>`), baseOpts);
    expect(html).toMatchObject({ text: 'Hello', parserVersion: 'html:1.1.0', metadata });
    const eml = await emailParser.parse(
      utf8(`Content-Type: text/html\n\n${hidden}<p>Hello</p>`),
      baseOpts
    );
    expect(eml).toMatchObject({ text: 'Hello', parserVersion: 'eml:1.1.0', metadata });
  });
});

describe('cost of finding hidden content', () => {
  const inputs: Array<[string, (count: number) => string]> = [
    ['style sheets', (n) => `<div hidden>x</div>${'<style>p{}</style>'.repeat(n)}`],
    ['unclosed styles', (n) => `<div hidden>x</div>${'<style '.repeat(n)}`],
    ['links', (n) => `<div hidden>x</div>${'<link rel=icon>'.repeat(n)}`],
    ['links in a tag', (n) => `<div hidden>x</div>${'<link '.repeat(n)}>`],
    ['hidden spans', (n) => `a ${'<span hidden>x</span> '.repeat(n)}`],
    ['whitespace before a span', (n) => `a${' '.repeat(n)}<span hidden>x</span> `.repeat(3)],
    ['unclosed hidden tags', (n) => '<div hidden>'.repeat(n)],
    ['hidden elements', (n) => '<div hidden>x</div>'.repeat(n)],
    ['unclosed tags', (n) => `hidden${'<b>'.repeat(n)}`],
    ['one deep candidate', (n) => `<div hidden>${'<b>'.repeat(n)}${'</b>'.repeat(n)}`],
    ['shallow content', (n) => `<div hidden>${'<b>x</b>'.repeat(n)}</div>`],
    ['cells', (n) => `<table>${'<td style="display:none">x</td>'.repeat(n)}`],
    ['raw text', (n) => `hidden${'<title>x</title>'.repeat(n)}`],
    ['unclosed raw text', (n) => `hidden${'<title>'.repeat(n)}`],
    ['scripts', (n) => `hidden${'<script><!--</script>'.repeat(n)}`],
    ['comments', (n) => `hidden${'<!-- x -->'.repeat(n)}`],
    ['sealed elements', (n) => `hidden${'<svg></svg>'.repeat(n)}`],
    ['attributes', (n) => `<div ${'hidden a="b" '.repeat(n)}>x</div>`],
    ['unclosed quotes', (n) => '<div hidden title="'.repeat(n)],
    ['whitespace', (n) => `<div hidden ${' '.repeat(n * 10)}><${' '.repeat(n * 10)}`],
    ['styles', (n) => `<div style="${'display:none;'.repeat(n)}">x</div>`],
    ['whitespace in a style', (n) => `<div style="display:${' '.repeat(n * 5)}none">x</div>`],
    [
      'whitespace before important',
      (n) => `<div style="display:none${' '.repeat(n * 5)}x">x</div>`,
    ],
  ];

  // Counts the characters that string and regular expression calls read, so that the speed of
  // the machine does not matter: 8 times the input is 8 times the work when linear, 64 times
  // when quadratic.
  it.each(inputs)('grows linearly with %s', (_name, build) => {
    const small = countWork(() => removeHiddenContent(build(500)));
    const large = countWork(() => removeHiddenContent(build(4_000)));
    expect(large).toBeLessThan(10 * small);
  });
});

/** Characters read by the built-in calls that the scan uses. Not exact, but never sublinear. */
function countWork(run: () => void): number {
  const string = String.prototype;
  const { slice, indexOf, includes, charCodeAt, split, toLowerCase } = string;
  const { exec } = RegExp.prototype;
  let work = 0;
  const read = (count: number): void => {
    work += count + 1;
  };
  const search = (text: string, needle: string, from: number): number => {
    const index = indexOf.call(text, needle, from);
    read((index < 0 ? text.length : index) - from);
    return index;
  };
  string.slice = function (start, end) {
    const result = slice.call(this, start, end);
    read(result.length);
    return result;
  };
  string.indexOf = function (needle, from = 0) {
    return search(String(this), needle, from);
  };
  string.includes = function (needle, from = 0) {
    return search(String(this), needle, from) >= 0;
  };
  string.charCodeAt = function (index) {
    read(1);
    return charCodeAt.call(this, index);
  };
  string.split = function (this: string, ...args: [string]) {
    read(this.length);
    return split.apply(this, args);
  } as typeof split;
  string.toLowerCase = function () {
    read(this.length);
    return toLowerCase.call(this);
  };
  RegExp.prototype.exec = function (text) {
    const from = this.global || this.sticky ? this.lastIndex : 0;
    const match = exec.call(this, text);
    const end = match ? match.index + match[0].length : this.sticky ? from : text.length;
    read(end - from);
    return match;
  };
  try {
    run();
  } finally {
    Object.assign(string, { slice, indexOf, includes, charCodeAt, split, toLowerCase });
    RegExp.prototype.exec = exec;
  }
  return work;
}
