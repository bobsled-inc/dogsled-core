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

  it('keeps the text on both sides separate', () => {
    expect(htmlToText('one<div hidden>x</div>two')).toBe('one\n\ntwo');
    expect(htmlToText('one<span hidden>x</span>two')).toBe('one two');
    expect(htmlToText('one <span hidden>x</span> two')).toBe('one two');
    expect(htmlToText('<p>one</p><div hidden>x</div><p>two</p>')).toBe('one\n\ntwo');
    expect(htmlToText('a < b <div hidden>x</div> c <p>d</p>')).toMatch(/c d$/);
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

  it('drops text that a style sheet shows again', () => {
    expect(around('<style>[hidden]{display:block}</style><div hidden>x</div>')).toBe(
      'before after'
    );
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

  // Growth, not time, so that a slow machine changes nothing: 16 times the input costs about
  // 16 times as much when linear, and 256 times as much when quadratic.
  it.each(inputs)('grows linearly with %s', (_name, build) => {
    const cost = (html: string): number => {
      const times = Array.from({ length: 5 }, () => {
        const start = performance.now();
        removeHiddenContent(html);
        return performance.now() - start;
      });
      return Math.min(...times);
    };
    const small = build(2_000);
    const large = build(32_000);
    cost(small);
    const floor = 0.05;
    expect(cost(large)).toBeLessThan(80 * Math.max(cost(small), floor));
  });
});
