import { describe, expect, it } from 'vitest';
import { deflateRawSync, deflateSync } from 'node:zlib';

import {
  docxParser,
  emailParser,
  createDefaultRegistry,
  htmlParser,
  markdownParser,
  pdfParser,
  pptxParser,
  textParser,
} from '../src/index.js';
import type { ParseError, ParsedDocument } from '../src/index.js';
import { PDF_SECURITY_LIMITS } from '../src/parsers/pdf.js';
import { readZipEntries, ZipReadError } from '../src/parsers/zip.js';

const baseOpts = {
  sourceUri: 'file:test',
  contentHash: 'abc123',
};

function utf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function testZip(files: Record<string, string>, opts: { deflate?: boolean } = {}): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const compressed = opts.deflate ? deflateRawSync(data) : data;
    const method = opts.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(data.byteLength, 22);
    local.writeUInt16LE(nameBytes.byteLength, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(data.byteLength, 24);
    central.writeUInt16LE(nameBytes.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.byteLength + nameBytes.byteLength + compressed.byteLength;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralDir.byteLength, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...localParts, centralDir, eocd]));
}

function simplePdfStream(contentStream: Buffer, filter = '/FlateDecode'): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(
        [
          '%PDF-1.4',
          '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
          '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
          '3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj',
          `4 0 obj << /Length ${contentStream.byteLength} /Filter ${filter} >> stream`,
          '',
        ].join('\n'),
        'latin1'
      ),
      contentStream,
      Buffer.from('\nendstream endobj\n%%EOF\n', 'latin1'),
    ])
  );
}

/** ASCII85 as PDF writes it: base-85 digits, `z` for a zero group, `~>` terminator. */
function ascii85(bytes: Buffer): Buffer {
  let out = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 4) {
    const group = bytes.subarray(offset, offset + 4);
    let value = 0;
    for (let i = 0; i < 4; i += 1) value = value * 256 + (group[i] ?? 0);
    if (group.byteLength === 4 && value === 0) {
      out += 'z';
      continue;
    }
    const digits: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      digits.unshift(String.fromCharCode(33 + (value % 85)));
      value = Math.floor(value / 85);
    }
    out += digits.slice(0, group.byteLength + 1).join('');
  }
  return Buffer.from(`${out}~>`, 'latin1');
}

function asciiHex(bytes: Buffer): Buffer {
  return Buffer.from(`${bytes.toString('hex')}>`, 'latin1');
}

/**
 * `BT /F1 24 Tf 72 700 Td (LZW encoded content stream) Tj ET\n`, LZW-encoded with
 * `EarlyChange = 1`. Produced by an independent encoder and confirmed by running
 * the containing PDF through poppler's `pdftotext`, so it pins the decoder to a
 * real-world bitstream rather than to a mirror of our own implementation.
 */
const LZW_ENCODED_TEXT_CONTENT =
  '80108a820179186220190d04054330806e32870c0610b32080504c2d15c40653718cde6432c563c6e3a470e820399d0e465309b4530b350808a5405404';

function pdfWithStreams(contentStreams: Buffer[], flate = true): Uint8Array {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  for (const content of contentStreams) {
    const encoded = flate ? deflateSync(content) : content;
    parts.push(
      Buffer.from(
        `<< /Length ${encoded.byteLength}${flate ? ' /Filter /FlateDecode' : ''} >> stream\n`,
        'latin1'
      ),
      encoded,
      Buffer.from('\nendstream\n', 'latin1')
    );
  }
  parts.push(Buffer.from('%%EOF\n', 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}

describe('textParser', () => {
  it('parses utf-8 text with line normalization', async () => {
    const result = (await textParser.parse(
      utf8('hello\r\nworld\rfoo\n'),
      baseOpts
    )) as ParsedDocument;
    expect(result.status).toBe('parsed');
    expect(result.text).toBe('hello\nworld\nfoo\n');
    expect(result.format).toBe('txt');
  });

  it('strips utf-8 BOM', async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const body = utf8('hi');
    const merged = new Uint8Array(bom.length + body.length);
    merged.set(bom);
    merged.set(body, bom.length);
    const result = (await textParser.parse(merged, baseOpts)) as ParsedDocument;
    expect(result.text).toBe('hi');
  });

  it('decodes UTF-16 BOM-prefixed text', async () => {
    const le = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    const be = new Uint8Array([0xfe, 0xff, 0x00, 0x6f, 0x00, 0x6b]);
    const leResult = (await textParser.parse(le, baseOpts)) as ParsedDocument;
    const beResult = (await textParser.parse(be, baseOpts)) as ParsedDocument;
    expect(leResult.text).toBe('hi');
    expect(beResult.text).toBe('ok');
  });

  it('rejects oversized files', async () => {
    const result = (await textParser.parse(utf8('x'.repeat(100)), {
      ...baseOpts,
      maxFileSizeBytes: 50,
    })) as ParseError;
    expect(result.status).toBe('error');
    expect(result.errorCode).toBe('file_too_large');
  });
});

describe('markdownParser', () => {
  it('removes badges inside links while preserving list spacing', async () => {
    const result = (await markdownParser.parse(
      utf8('[![CI](badge.svg)](https://example.com)\n\nText\n\n- item'),
      baseOpts
    )) as ParsedDocument;
    expect(result.text).toBe('Text\n\nitem');
    expect(result.parserVersion).toBe('md:1.2.0');
  });
  it('strips markdown syntax', async () => {
    const md = utf8('# Title\n\nSome **bold** _italic_ and [link](https://example.com).\n');
    const result = (await markdownParser.parse(md, baseOpts)) as ParsedDocument;
    expect(result.status).toBe('parsed');
    expect(result.text).toContain('Title');
    expect(result.text).toContain('bold');
    expect(result.text).toContain('italic');
    expect(result.text).toContain('link');
    expect(result.text).not.toContain('https://example.com');
    expect(result.text).not.toContain('#');
    expect(result.text).not.toContain('**');
  });

  it('extracts YAML front-matter', async () => {
    const md = utf8('---\ntitle: Hello\n---\nBody text.\n');
    const result = (await markdownParser.parse(md, baseOpts)) as ParsedDocument;
    expect(result.metadata['frontMatter']).toContain('title: Hello');
    expect(result.text).toBe('Body text.');
  });

  it('drops images and code-fence delimiters but keeps code text', async () => {
    const md = utf8('![alt](img.png)\n```ts\nconst x = 1;\n```\n');
    const result = (await markdownParser.parse(md, baseOpts)) as ParsedDocument;
    expect(result.text).not.toContain('alt');
    expect(result.text).not.toContain('![');
    expect(result.text).not.toContain('```');
    expect(result.text).toContain('const x = 1;');
  });

  it('preserves literal placeholder-shaped text outside fences (collision regression)', async () => {
    // A user-authored markdown body that literally contains `@@CBLOCK0@@` previously
    // got eaten by the placeholder-restoration pass under a fixed-prefix scheme. The
    // per-parse random nonce makes user collision impossible.
    const md = utf8('Read the rule about @@CBLOCK0@@ here.\n');
    const result = (await markdownParser.parse(md, baseOpts)) as ParsedDocument;
    expect(result.text).toContain('@@CBLOCK0@@');
  });
});

describe('htmlParser', () => {
  it('extracts text from a small page and decodes named entities', async () => {
    const html = utf8(
      '<html><head><title>Hi</title><script>alert(1)</script></head>' +
        '<body><h1>H&amp;M</h1><p>Hello&nbsp;world &mdash; &#x2014; ok.</p></body></html>'
    );
    const result = (await htmlParser.parse(html, baseOpts)) as ParsedDocument;
    expect(result.status).toBe('parsed');
    expect(result.text).toContain('H&M');
    expect(result.text).toContain('Hello world');
    expect(result.text).toContain('—');
    expect(result.text).not.toContain('alert(1)');
    expect(result.text).not.toContain('<');
    expect(result.metadata['title']).toBe('Hi');
  });
});

describe('binary and container parsers', () => {
  it('applies a default ZIP uncompressed-size cap when options omit one', () => {
    const name = 'huge.txt';
    const zip = Buffer.from(testZip({ [name]: 'x' }));
    const centralDirectoryOffset = 30 + Buffer.byteLength(name, 'utf8') + 1;
    zip.writeUInt32LE(64 * 1024 * 1024 + 1, centralDirectoryOffset + 24);

    expect(() => readZipEntries(new Uint8Array(zip))).toThrow(ZipReadError);
    expect(() => readZipEntries(new Uint8Array(zip))).toThrow(/max uncompressed size/);
  });

  it('extracts text from a Flate-compressed PDF stream', async () => {
    const compressed = deflateSync(Buffer.from('BT /F1 12 Tf 72 720 Td (Quarterly results) Tj ET'));
    const result = (await pdfParser.parse(simplePdfStream(compressed), baseOpts)) as ParsedDocument;
    expect(result.status).toBe('parsed');
    expect(result.text).toContain('Quarterly results');
    expect(result.metadata['pageCount']).toBe(1);
  });

  it('applies an /ASCII85Decode + /FlateDecode filter chain in declared order', async () => {
    // ReportLab emits this chain by default; decoding only the Flate stage feeds
    // ASCII85 text to zlib and fails with "incorrect header check".
    const encoded = ascii85(deflateSync(Buffer.from('BT (Carousel quarterly results) Tj ET')));
    const pdf = simplePdfStream(encoded, '[ /ASCII85Decode /FlateDecode ]');

    const result = (await pdfParser.parse(pdf, baseOpts)) as ParsedDocument;
    expect(result.status).toBe('parsed');
    expect(result.text).toContain('Carousel quarterly results');
  });

  it('decodes single-stage /ASCII85Decode and /ASCIIHexDecode streams', async () => {
    const content = Buffer.from('BT (Plain ascii filter) Tj ET', 'latin1');

    const a85 = (await pdfParser.parse(
      simplePdfStream(ascii85(content), '/ASCII85Decode'),
      baseOpts
    )) as ParsedDocument;
    expect(a85.text).toContain('Plain ascii filter');

    const hex = (await pdfParser.parse(
      simplePdfStream(asciiHex(content), '[ /ASCIIHexDecode ]'),
      baseOpts
    )) as ParsedDocument;
    expect(hex.text).toContain('Plain ascii filter');
  });

  it('decodes /LZWDecode streams', async () => {
    const encoded = Buffer.from(LZW_ENCODED_TEXT_CONTENT, 'hex');

    const result = (await pdfParser.parse(
      simplePdfStream(encoded, '/LZWDecode'),
      baseOpts
    )) as ParsedDocument;
    expect(result.status).toBe('parsed');
    expect(result.text).toContain('LZW encoded content stream');
  });

  it('decodes /RunLengthDecode streams', async () => {
    const content = Buffer.from('BT (Run length text) Tj ET', 'latin1');
    const encoded = Buffer.concat([
      Buffer.from([content.byteLength - 1]),
      content,
      Buffer.from([128]),
    ]);

    const result = (await pdfParser.parse(
      simplePdfStream(encoded, '/RunLengthDecode'),
      baseOpts
    )) as ParsedDocument;
    expect(result.text).toContain('Run length text');
  });

  it('skips image-codec streams instead of failing the document', async () => {
    const readable = deflateSync(Buffer.from('BT (Readable page text) Tj ET'));
    const pdf = new Uint8Array(
      Buffer.concat([
        Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n', 'latin1'),
        Buffer.from(
          `2 0 obj << /Length 4 /Filter [ /ASCII85Decode /DCTDecode ] >> stream\n`,
          'latin1'
        ),
        Buffer.from('ÿØÿà', 'latin1'),
        Buffer.from('\nendstream endobj\n', 'latin1'),
        Buffer.from(
          `3 0 obj << /Length ${readable.byteLength} /Filter /FlateDecode >> stream\n`,
          'latin1'
        ),
        readable,
        Buffer.from('\nendstream endobj\n%%EOF\n', 'latin1'),
      ])
    );

    const result = (await pdfParser.parse(pdf, baseOpts)) as ParsedDocument;
    expect(result.status).toBe('parsed');
    expect(result.text).toContain('Readable page text');
  });

  it('skips streams whose /Filter cannot be resolved to filter names', async () => {
    // An indirect `/Filter` reference is unreadable without object resolution, so
    // the body must not be mistaken for raw content and scanned for text.
    const pdf = simplePdfStream(deflateSync(Buffer.from('BT (Hidden) Tj ET')), '9 0 R');

    const result = (await pdfParser.parse(pdf, baseOpts)) as ParsedDocument;
    expect(result.status).toBe('parsed');
    expect(result.text).toBe('');
  });

  it('names the failing filter and object when a stream stage rejects its input', async () => {
    const pdf = simplePdfStream(Buffer.from('not zlib framed', 'latin1'), '/FlateDecode');

    const result = (await pdfParser.parse(pdf, baseOpts)) as ParseError;
    expect(result.status).toBe('error');
    expect(result.errorCode).toBe('corrupt_input');
    expect(result.message).toContain('/FlateDecode');
    expect(result.message).toContain('object 4 0');
  });

  it('rejects PDFs whose streams exceed the aggregate decompression budget', async () => {
    const streamSize = Math.floor(PDF_SECURITY_LIMITS.maxDecompressedBytes / 4);
    const bomb = pdfWithStreams(Array.from({ length: 5 }, () => Buffer.alloc(streamSize, 0x78)));

    const result = (await pdfParser.parse(bomb, baseOpts)) as ParseError;
    expect(result.status).toBe('error');
    expect(result.errorCode).toBe('file_too_large');
    expect(result.message).toContain('aggregate decompression limit');
  });

  it('rejects a single PDF stream above the per-stream decompression budget', async () => {
    const bomb = pdfWithStreams([Buffer.alloc(PDF_SECURITY_LIMITS.maxStreamBytes + 1, 0x78)]);

    const result = (await pdfParser.parse(bomb, baseOpts)) as ParseError;
    expect(result.status).toBe('error');
    expect(result.errorCode).toBe('file_too_large');
    expect(result.message).toContain('content stream exceeds');
  });

  it('rejects PDFs with too many content streams', async () => {
    const bomb = pdfWithStreams(
      Array.from({ length: PDF_SECURITY_LIMITS.maxStreams + 1 }, () => Buffer.alloc(0)),
      false
    );

    const result = (await pdfParser.parse(bomb, baseOpts)) as ParseError;
    expect(result.status).toBe('error');
    expect(result.errorCode).toBe('file_too_large');
    expect(result.message).toContain('content streams');
  });

  it('rejects PDFs whose extracted text exceeds the text budget', async () => {
    const textPerStream = Math.floor(PDF_SECURITY_LIMITS.maxExtractedTextChars / 2) + 1;
    const content = Buffer.from(`BT (${'x'.repeat(textPerStream)}) Tj ET`, 'latin1');
    const bomb = pdfWithStreams([content, content]);

    const result = (await pdfParser.parse(bomb, baseOpts)) as ParseError;
    expect(result.status).toBe('error');
    expect(result.errorCode).toBe('file_too_large');
    expect(result.message).toContain('extracted text');
  });

  it('extracts text from DOCX word XML', async () => {
    const docx = testZip(
      {
        'word/document.xml':
          '<w:document><w:body><w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p></w:body></w:document>',
      },
      { deflate: true }
    );
    const result = (await docxParser.parse(docx, baseOpts)) as ParsedDocument;
    expect(result.status).toBe('parsed');
    expect(result.text).toBe('Hello & welcome');
  });

  it('rejects DOCX containers whose inflated XML exceeds the parser limit', async () => {
    const docx = testZip(
      {
        'word/document.xml': `<w:document><w:body><w:p><w:r><w:t>${'x'.repeat(
          4096
        )}</w:t></w:r></w:p></w:body></w:document>`,
      },
      { deflate: true }
    );
    const result = (await docxParser.parse(docx, {
      ...baseOpts,
      maxFileSizeBytes: 1024,
    })) as ParseError;
    expect(result.status).toBe('error');
    expect(result.errorCode).toBe('file_too_large');
  });

  it('extracts slide text from PPTX slide XML in numeric order', async () => {
    const pptx = testZip({
      'ppt/slides/slide2.xml': '<p:sld><a:t>Second slide</a:t></p:sld>',
      'ppt/slides/slide1.xml': '<p:sld><a:t>First slide</a:t></p:sld>',
    });
    const result = (await pptxParser.parse(pptx, baseOpts)) as ParsedDocument;
    expect(result.status).toBe('parsed');
    expect(result.text).toBe('First slide\n\nSecond slide');
    expect(result.metadata['slideCount']).toBe(2);
  });

  it('extracts preferred text/plain body from multipart email', async () => {
    const eml = utf8(
      [
        'Subject: =?UTF-8?Q?Q4_Update?=',
        'From: Ops <ops@example.com>',
        'Content-Type: multipart/alternative; boundary="b"',
        '',
        '--b',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'Plain=20body',
        '--b',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>HTML body</p>',
        '--b--',
      ].join('\r\n')
    );
    const result = (await emailParser.parse(eml, baseOpts)) as ParsedDocument;
    expect(result.status).toBe('parsed');
    expect(result.text).toBe('Plain body');
    expect(result.metadata['subject']).toBe('Q4 Update');
  });

  it('does not claim mbox framing support', () => {
    expect(emailParser.supportedExtensions).not.toContain('mbox');
  });
});

describe('DocumentParserRegistry', () => {
  it('routes by file extension', async () => {
    const reg = createDefaultRegistry();
    const md = (await reg.parse('file:doc.md', utf8('# Hi'), baseOpts)) as ParsedDocument;
    expect(md.format).toBe('md');
    const html = (await reg.parse(
      's3://bucket/page.html',
      utf8('<p>x</p>'),
      baseOpts
    )) as ParsedDocument;
    expect(html.format).toBe('html');
  });

  it('returns unsupported_format for unknown extensions', async () => {
    const reg = createDefaultRegistry();
    const result = (await reg.parse('file:unknown.xyz', utf8('content'), baseOpts)) as ParseError;
    expect(result.errorCode).toBe('unsupported_format');
  });

  it('omits URI query strings and fragments from unsupported-format errors', async () => {
    const reg = createDefaultRegistry();
    const result = (await reg.parse(
      'https://example.com/private/file.unknown?X-Amz-Signature=secret#frag',
      utf8('x'),
      baseOpts
    )) as ParseError;

    expect(result.status).toBe('error');
    expect(result.errorCode).toBe('unsupported_format');
    expect(result.message).toContain('https://example.com/private/file.unknown');
    expect(result.message).not.toContain('X-Amz-Signature');
    expect(result.message).not.toContain('#frag');
  });

  it('routes pdf to the PDF parser', async () => {
    const reg = createDefaultRegistry();
    const compressed = deflateSync(Buffer.from('BT (Deck text) Tj ET'));
    const result = (await reg.parse(
      's3://bucket/q4.pdf',
      simplePdfStream(compressed),
      baseOpts
    )) as ParsedDocument;
    expect(result.format).toBe('pdf');
    expect(result.text).toContain('Deck text');
  });

  it('routes URIs with query strings or fragments by path extension', async () => {
    const reg = createDefaultRegistry();
    const pdf = (await reg.parse(
      's3://bucket/q4.pdf?versionId=123#page=1',
      simplePdfStream(deflateSync(Buffer.from('BT (Versioned text) Tj ET'))),
      baseOpts
    )) as ParsedDocument;
    expect(pdf.format).toBe('pdf');
    expect(pdf.text).toContain('Versioned text');
  });
});
