import { markdownParser } from '../src/parsers/markdown.js';
import { describe, expect, it } from 'vitest';
import { normalizeExtractedText } from '../src/parsers/xml.js';
import { htmlParser, htmlToText } from '../src/parsers/html.js';
describe('bounded parser scanning', () => {
  it('normalizes 200 KB of whitespace in under one second', () => {
    const start = performance.now();
    expect(normalizeExtractedText(' '.repeat(200_000))).toBe('');
    expect(performance.now() - start).toBeLessThan(1000);
    expect(normalizeExtractedText('one  \t\n \t two\r\n\n\nthree')).toBe('one\ntwo\n\nthree');
  });
  it.each(['<!--', '<script>', '<style>', '<noscript>', '<'])(
    'scans unclosed %s blocks in linear time',
    (prefix) => {
      const start = performance.now();
      htmlToText(prefix.repeat(50_000));
      expect(performance.now() - start).toBeLessThan(1000);
    }
  );
  it('bounds title scanning and preserves block text', async () => {
    const start = performance.now();
    await htmlParser.parse(new TextEncoder().encode('<title>'.repeat(30_000)), {
      sourceUri: 'file:test.html',
      contentHash: 'synthetic',
    });
    expect(performance.now() - start).toBeLessThan(1000);
    expect(htmlToText('<p>one</p><!--gone--><script>hidden</script><p>two</p>')).toBe('one\n\ntwo');
  });
  it('preserves Unicode offsets and collapses whitespace after break tags', async () => {
    expect(htmlToText('İ<p>one</p><script>hidden</script><p>two</p>')).toBe('İone\n\ntwo');
    expect(htmlToText('one<br>  \n two<hr> \nthree')).toBe('one\ntwo\n\nthree');
    const parsed = await htmlParser.parse(
      new TextEncoder().encode('İ<TITLE>Title</TITLE><p>body</p>'),
      { sourceUri: 'file:test.html', contentHash: 'synthetic' }
    );
    expect(parsed.status).toBe('parsed');
    if (parsed.status === 'parsed') expect(parsed.metadata.title).toBe('Title');
  });
});

describe('bounded Markdown scanning', () => {
  it.each(['\n', '[', '![', '<!--'])('parses repeated %j in under one second', async (part) => {
    const input = new TextEncoder().encode(part.repeat(100_000));
    const start = performance.now();
    const parsed = await markdownParser.parse(input, {
      sourceUri: 'file:test.md',
      contentHash: 'synthetic',
    });
    expect(parsed.status).toBe('parsed');
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('preserves text around links, images and incomplete markup', async () => {
    const parsed = await markdownParser.parse(
      new TextEncoder().encode(
        'A [link](https://example.com) ![image](x) [ref][id] <!--hide--> [open'
      ),
      { sourceUri: 'file:test.md', contentHash: 'synthetic' }
    );
    expect(parsed).toMatchObject({ status: 'parsed', text: 'A link  ref  [open' });
  });
});
