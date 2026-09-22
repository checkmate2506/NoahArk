import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ValidationError } from "@noahark/core";
import { assertAllowedUploadMime, sniffMimeType } from "./mimeSniff";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);
const TINY_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
const TINY_WEBP = Buffer.from(
  "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=",
  "base64",
);
const PLAIN = Buffer.from("hello noahark\n", "utf8");
const CSV = Buffer.from("name,qty\nwidget,1\n", "utf8");
const HTML = Buffer.from("<!DOCTYPE html><html><body>x</body></html>", "utf8");
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
  "utf8",
);
const XML = Buffer.from('<?xml version="1.0"?><root/>', "utf8");
const JS = Buffer.from("function exploit() { return 1; }\n", "utf8");
const ZIP = Buffer.from("PK\u0003\u0004", "utf8");
const OOXML = Buffer.from("PK\u0003\u0004[Content_Types].xml", "utf8");
const EXE = Buffer.from("MZ".padEnd(64, "\0") + "PE", "utf8");
const UNKNOWN = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
const COMMENT_SVG = Buffer.from("<!--x--><svg onload=alert(1)>", "utf8");

const XMP_PACKET =
  "<?xpacket begin='' id='W5M0MpCehiHzreSzNTczkc9d'?>" +
  "<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>" +
  "<rdf:Description rdf:about=''/></rdf:RDF></x:xmpmeta><?xpacket end='w'?>";

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function buildPng(
  pixels: Buffer,
  width: number,
  height: number,
  extra: Buffer[] = [],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = deflateSync(pixels);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    ...extra,
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function rgbRows(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number],
): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = fill(x, y);
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

function pdfWithBody(body: string): Buffer {
  const content = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R /Metadata 3 0 R >>
endobj
2 0 obj
<< /Type /Pages /Count 0 /Kids [] >>
endobj
3 0 obj
<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(body)} >>
stream
${body}
endstream
endobj
trailer
<< /Root 1 0 R >>
%%EOF
`;
  return Buffer.from(content, "utf8");
}

function jpegWithExif(base: Buffer): Buffer {
  const exif = Buffer.concat([
    Buffer.from("Exif\0\0", "ascii"),
    Buffer.from("II*\0\x08\0\0\0", "binary"),
  ]);
  const app1 = Buffer.alloc(4 + exif.byteLength);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(2 + exif.byteLength, 2);
  exif.copy(app1, 4);
  return Buffer.concat([base.subarray(0, 2), app1, base.subarray(2)]);
}

function gifWithComment(base: Buffer): Buffer {
  const comment = Buffer.from([0x21, 0xfe, 0x04, 0x6e, 0x6f, 0x61, 0x68, 0x00]);
  const trailer = base.lastIndexOf(0x3b);
  if (trailer === -1) return Buffer.concat([base, comment, Buffer.from([0x3b])]);
  return Buffer.concat([base.subarray(0, trailer), comment, base.subarray(trailer)]);
}

function webpWithXmp(base: Buffer): Buffer {
  const xmp = Buffer.from(XMP_PACKET, "utf8");
  const pad = xmp.byteLength % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
  const chunk = Buffer.concat([Buffer.from("XMP ", "ascii"), Buffer.alloc(4), xmp, pad]);
  chunk.writeUInt32LE(xmp.byteLength, 4);
  const body = Buffer.concat([base.subarray(12), chunk]);
  const out = Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.alloc(4),
    Buffer.from("WEBP", "ascii"),
    body,
  ]);
  out.writeUInt32LE(out.byteLength - 8, 4);
  return out;
}

async function accept(buffer: Buffer, mime: string) {
  expect(await sniffMimeType(buffer)).toBe(mime);
  expect(() => assertAllowedUploadMime(mime, buffer)).not.toThrow();
}

async function deny(buffer: Buffer) {
  const mime = await sniffMimeType(buffer);
  expect(() => assertAllowedUploadMime(mime, buffer)).toThrow(ValidationError);
}

async function denyDisguisedText(buffer: Buffer) {
  const mime = await sniffMimeType(buffer);
  expect(mime).not.toBe("text/plain");
  expect(mime).not.toBe("text/csv");
  expect(() => assertAllowedUploadMime(mime, buffer)).toThrow(ValidationError);
  expect(() => assertAllowedUploadMime("text/plain", buffer)).toThrow(ValidationError);
  expect(() => assertAllowedUploadMime("text/csv", buffer)).toThrow(ValidationError);
  expect(() => assertAllowedUploadMime("image/png", buffer)).toThrow(ValidationError);
}

describe("P2D.0 MIME allowlist", () => {
  it("accepts PDF, PNG, JPEG, GIF, WebP, plain text and CSV by sniffed bytes", async () => {
    await accept(TINY_PNG, "image/png");
    await accept(TINY_JPEG, "image/jpeg");
    await accept(TINY_GIF, "image/gif");
    await accept(TINY_WEBP, "image/webp");
    await accept(pdfWithBody("ok"), "application/pdf");
    await accept(PLAIN, "text/plain");
    await accept(CSV, "text/csv");
  });

  it("rejects HTML, SVG, XML, JavaScript, executables, generic archives and unknown bytes", async () => {
    await deny(HTML);
    await deny(SVG);
    await deny(XML);
    await deny(JS);
    await deny(ZIP);
    await deny(OOXML);
    await deny(EXE);
    await deny(UNKNOWN);
  });

  it("does not trust a spoofed client MIME type or filename extension", async () => {
    expect(await sniffMimeType(HTML)).not.toBe("image/png");
    expect(() => assertAllowedUploadMime("image/png", HTML)).toThrow(ValidationError);
    expect(() => assertAllowedUploadMime("text/plain", HTML)).toThrow(ValidationError);
    expect(() => assertAllowedUploadMime("text/csv", JS)).toThrow(ValidationError);
    expect(await sniffMimeType(COMMENT_SVG)).not.toBe("text/plain");
    expect(() => assertAllowedUploadMime("text/plain", COMMENT_SVG)).toThrow(
      ValidationError,
    );
    expect(() => assertAllowedUploadMime("text/csv", COMMENT_SVG)).toThrow(
      ValidationError,
    );
  });

  it("rejects empty buffers at the allowlist even if a caller skipped the size check", async () => {
    const empty = Buffer.alloc(0);
    expect(await sniffMimeType(empty)).toBe("application/octet-stream");
    await deny(empty);
  });

  it("rejects a PNG magic prefix followed by HTML (polyglot-style mismatch)", async () => {
    const polyglot = Buffer.concat([
      TINY_PNG.subarray(0, 8),
      Buffer.from("<html>x</html>"),
    ]);
    const mime = await sniffMimeType(polyglot);
    if (mime === "image/png") {
      expect(() => assertAllowedUploadMime(mime, polyglot)).toThrow(ValidationError);
    } else {
      await deny(polyglot);
    }
  });
});

describe("P2D.0 MIME allowlist — realistic binary content", () => {
  it("accepts a PDF with ordinary dictionaries and legitimate XMP", async () => {
    await accept(pdfWithBody("<< /Producer (NoahArk) >>"), "application/pdf");
    await accept(pdfWithBody(XMP_PACKET), "application/pdf");
  });

  it("accepts a JPEG containing an EXIF APP1 segment", async () => {
    await accept(jpegWithExif(TINY_JPEG), "image/jpeg");
  });

  it("accepts PNGs with compressed pixels, including patterns that look like markup in raw bytes", async () => {
    const solid = buildPng(
      rgbRows(8, 8, () => [0x3c, 0x73, 0x76]),
      8,
      8,
    );
    const gradient = buildPng(
      rgbRows(8, 8, (x, y) => [x * 30, y * 30, 0x6f]),
      8,
      8,
    );
    const noisy = buildPng(
      rgbRows(8, 8, (x, y) => [(x * 19 + y * 7) & 255, (x * 3) & 255, 0x6e]),
      8,
      8,
    );
    await accept(solid, "image/png");
    await accept(gradient, "image/png");
    await accept(noisy, "image/png");
  });

  it("accepts a PNG containing iTXt/XMP metadata", async () => {
    const keyword = Buffer.from("XML:com.adobe.xmp\0\0\0\0\0", "utf8");
    const png = buildPng(
      rgbRows(2, 2, () => [10, 20, 30]),
      2,
      2,
      [pngChunk("iTXt", Buffer.concat([keyword, Buffer.from(XMP_PACKET, "utf8")]))],
    );
    await accept(png, "image/png");
  });

  it("accepts a GIF with a comment extension", async () => {
    await accept(gifWithComment(TINY_GIF), "image/gif");
  });

  it("accepts a WebP containing an XMP metadata chunk", async () => {
    await accept(webpWithXmp(TINY_WEBP), "image/webp");
  });
});

describe("P2D.0 MIME allowlist — comment/BOM/whitespace disguised active content", () => {
  it("rejects comment-prefixed SVG with an event handler", async () => {
    await denyDisguisedText(COMMENT_SVG);
  });

  it("rejects BOM + comment + SVG", async () => {
    await denyDisguisedText(
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('<!--x--><svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8"),
      ]),
    );
  });

  it("rejects whitespace + multiple comments + mixed-case SVG", async () => {
    await denyDisguisedText(
      Buffer.from(" \t\r\n<!--a--><!--b--><SvG OnLoAd=alert(1)>", "utf8"),
    );
  });

  it("rejects comment + HTML", async () => {
    await denyDisguisedText(Buffer.from("<!--x--><html><body>x</body></html>", "utf8"));
  });

  it("rejects comment + XML declaration and comment + XML root", async () => {
    await denyDisguisedText(Buffer.from('<!--x--><?xml version="1.0"?><root/>', "utf8"));
    await denyDisguisedText(Buffer.from("<!--x--><root/>", "utf8"));
  });

  it("rejects comment + script", async () => {
    await denyDisguisedText(Buffer.from("<!--x--><script>alert(1)</script>", "utf8"));
  });

  it("rejects comment + iframe, object, and embed", async () => {
    await denyDisguisedText(Buffer.from("<!--x--><iframe src=x></iframe>", "utf8"));
    await denyDisguisedText(Buffer.from("<!--x--><object data=x></object>", "utf8"));
    await denyDisguisedText(Buffer.from("<!--x--><embed src=x>", "utf8"));
  });

  it("rejects event-handler attributes inside tags", async () => {
    await denyDisguisedText(Buffer.from("<svg onload=alert(1)>", "utf8"));
    await denyDisguisedText(Buffer.from("<img src=x onerror=alert(1)>", "utf8"));
  });

  it("rejects a javascript: URL inside an attribute", async () => {
    await denyDisguisedText(Buffer.from('<a href="javascript:alert(1)">x</a>', "utf8"));
  });

  it("rejects a javascript: URL payload", async () => {
    await denyDisguisedText(Buffer.from("javascript:alert(1)", "utf8"));
  });

  it("accepts ordinary safe text, comparisons, and on-prefixed prose", async () => {
    await accept(Buffer.from("Cost is < 10 SGD for the lot.\n", "utf8"), "text/plain");
    await accept(Buffer.from("a < b\n", "utf8"), "text/plain");
    await accept(Buffer.from("onions = 3\n", "utf8"), "text/plain");
    await accept(Buffer.from("online=true\n", "utf8"), "text/plain");
  });

  it("accepts ordinary safe CSV", async () => {
    await accept(CSV, "text/csv");
    await accept(Buffer.from("a,b,c\n1,2,3\n", "utf8"), "text/csv");
  });

  it("rejects active markup that appears only after byte 4096", async () => {
    const prefix = Buffer.alloc(4100, 0x61);
    await denyDisguisedText(
      Buffer.concat([prefix, Buffer.from("<svg onload=alert(1)>")]),
    );
    await denyDisguisedText(
      Buffer.concat([prefix, Buffer.from("<script>alert(1)</script>")]),
    );
  });

  it("rejects truncated or signature-only PDF, PNG, JPEG, GIF and WebP", async () => {
    await deny(Buffer.from("%PDF-1.4\n", "utf8"));
    await deny(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await deny(TINY_PNG.subarray(0, 29));
    await deny(Buffer.from([0xff, 0xd8, 0xff]));
    await deny(TINY_GIF.subarray(0, 20));
    await deny(TINY_WEBP.subarray(0, 16));
  });

  it("rejects a completed binary file with an invalid trailing payload", async () => {
    await deny(Buffer.concat([TINY_PNG, Buffer.from("<script>alert(1)</script>")]));
    await deny(Buffer.concat([TINY_JPEG, Buffer.from("javascript:alert(1)")]));
    await deny(Buffer.concat([TINY_GIF, Buffer.from("<!--x--><svg>")]));
    await deny(Buffer.concat([TINY_WEBP, Buffer.from("TRAIL")]));
    await deny(Buffer.concat([pdfWithBody("ok"), Buffer.from("<html>x</html>")]));
  });
});

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const out = Buffer.alloc(4 + payload.byteLength);
  out[0] = 0xff;
  out[1] = marker;
  out.writeUInt16BE(2 + payload.byteLength, 2);
  payload.copy(out, 4);
  return out;
}

function jpegTables(): Buffer[] {
  const dqt = jpegSegment(
    0xdb,
    Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)]),
  );
  const dhtCounts = Buffer.alloc(16);
  dhtCounts[0] = 1;
  const dht = jpegSegment(
    0xc4,
    Buffer.concat([Buffer.from([0x00]), dhtCounts, Buffer.from([0x00])]),
  );
  return [dqt, dht];
}

function buildProgressiveJpeg(extra: Buffer[] = []): Buffer {
  const sof2 = jpegSegment(
    0xc2,
    Buffer.from([0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00]),
  );
  const sosDc = jpegSegment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x00, 0x00]));
  const sosAc = jpegSegment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x3f, 0x00]));
  const scan1 = Buffer.from([0x00, 0x11, 0xff, 0x00, 0x22]);
  const scan2 = Buffer.from([0x33, 0xff, 0xd2, 0x44]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...extra,
    ...jpegTables(),
    sof2,
    sosDc,
    scan1,
    sosAc,
    scan2,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function buildMultiScanBaselineJpeg(): Buffer {
  const sof0 = jpegSegment(
    0xc0,
    Buffer.from([0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00]),
  );
  const sos1 = jpegSegment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x00, 0x00]));
  const sos2 = jpegSegment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x3f, 0x00]));
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...jpegTables(),
    sof0,
    sos1,
    Buffer.from([0x00, 0xff, 0x00, 0x01]),
    sos2,
    Buffer.from([0x02, 0xff, 0xd0, 0x03]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function countMarker(buffer: Buffer, marker: number): number {
  const needle = Buffer.from([0xff, marker]);
  let count = 0;
  let from = 0;
  for (;;) {
    const found = buffer.indexOf(needle, from);
    if (found === -1) return count;
    count += 1;
    from = found + 2;
  }
}

function assertConstructedJpeg(
  buffer: Buffer,
  sofMarker: number,
  sosCount: number,
): void {
  expect(buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
  expect(buffer.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
  expect(countMarker(buffer, sofMarker)).toBe(1);
  expect(countMarker(buffer, 0xda)).toBe(sosCount);
}

describe("P2D.0 MIME allowlist — linear text scan and HTML5 comment variants", () => {
  it("rejects incomplete tag-start adversarial payloads without hanging", async () => {
    const ninetySixKb = Buffer.from("<a" + "x".repeat(96 * 1024), "utf8");
    const oneNinetyTwoKb = Buffer.from("<a" + "x".repeat(192 * 1024), "utf8");
    const oneMb = Buffer.from("<" + "b".repeat(1024 * 1024), "utf8");
    const repeatedOpener = Buffer.from("<a".repeat(100_000), "utf8");
    for (const payload of [ninetySixKb, oneNinetyTwoKb, oneMb, repeatedOpener]) {
      await denyDisguisedText(payload);
    }
  }, 15_000);

  it("rejects HTML5 comment-terminator bypasses at the start, middle and after 4096 bytes", async () => {
    const variants = [
      "<!--c--!><svg onload=alert(1)> -->",
      "<!--c--!><script>alert(1)</script> -->",
      "<!--c--!><iframe src=x></iframe> -->",
      "<!--> <svg onload=alert(1)> -->",
      "<!---> <svg onload=alert(1)> -->",
      "<!--x--><!--y--><SvG>",
      "hello <!--> <svg onload=alert(1)> -->",
      "hello <!--c--!><script>alert(1)</script> -->",
    ];
    for (const variant of variants) {
      await denyDisguisedText(Buffer.from(variant, "utf8"));
    }
    await denyDisguisedText(
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(" \t\r\n<!--> <svg onload=alert(1)> -->", "utf8"),
      ]),
    );
    await denyDisguisedText(
      Buffer.concat([
        Buffer.alloc(4100, 0x61),
        Buffer.from("<!---> <iframe src=x>", "utf8"),
      ]),
    );
  });

  it("rejects unsafe C0 controls while accepting TAB, LF and CR", async () => {
    await accept(Buffer.from("col1,col2\tmore\r\nvalue\n", "utf8"), "text/csv");
    await accept(Buffer.from("line\tone\r\nline two\n", "utf8"), "text/plain");
    await deny(Buffer.from("nul\u0000here", "utf8"));
    await deny(Buffer.from("soh\u0001here", "utf8"));
    await deny(Buffer.from("bel\u0007here", "utf8"));
    await deny(Buffer.from("bs\u0008here", "utf8"));
    await deny(Buffer.from("vt\u000bhere", "utf8"));
    await deny(Buffer.from("ff\u000chere", "utf8"));
    await deny(Buffer.from("si\u000ehere", "utf8"));
    await deny(Buffer.from("us\u001fhere", "utf8"));
  });

  it("rejects namespace-prefixed and XML NameStart markup, including _:svg", async () => {
    await denyDisguisedText(
      Buffer.from(
        '<_:svg xmlns:_="http://www.w3.org/2000/svg" onload="alert(1)"/>',
        "utf8",
      ),
    );
    await denyDisguisedText(
      Buffer.from('<x:svg xmlns:x="http://www.w3.org/2000/svg"/>', "utf8"),
    );
    await denyDisguisedText(Buffer.from("<_foo/>", "utf8"));
    await denyDisguisedText(Buffer.from("<:bar/>", "utf8"));
    await denyDisguisedText(
      Buffer.from('<αsvg xmlns="http://www.w3.org/2000/svg"/>', "utf8"),
    );
  });

  it("accepts comparison prose after XML-name markup tightening", async () => {
    await accept(Buffer.from("Cost is < 10 SGD for the lot.\n", "utf8"), "text/plain");
    await accept(Buffer.from("a < b\n", "utf8"), "text/plain");
    await accept(Buffer.from("2 < 3\n", "utf8"), "text/plain");
  });

  it("scans a complete large benign text buffer without hanging", async () => {
    const line = "lot cost is < 10 SGD and 2 < 3 and onions = 3\n";
    const repeats = Math.ceil((512 * 1024) / line.length);
    const payload = Buffer.from(line.repeat(repeats), "utf8");
    expect(payload.byteLength).toBeGreaterThan(512 * 1024);
    await accept(payload, "text/plain");
  }, 5_000);
});

describe("P2D.0 MIME allowlist — progressive JPEG and PNG/GIF framing", () => {
  it("accepts progressive and multi-scan JPEGs, including metadata APP/COM segments", async () => {
    const progressive = buildProgressiveJpeg();
    assertConstructedJpeg(progressive, 0xc2, 2);
    await accept(progressive, "image/jpeg");

    const multiScan = buildMultiScanBaselineJpeg();
    assertConstructedJpeg(multiScan, 0xc0, 2);
    await accept(multiScan, "image/jpeg");

    const xmp = jpegSegment(
      0xe1,
      Buffer.concat([
        Buffer.from("http://ns.adobe.com/xap/1.0/\0"),
        Buffer.from(XMP_PACKET),
      ]),
    );
    const icc = jpegSegment(
      0xe2,
      Buffer.concat([Buffer.from("ICC_PROFILE\0\x01\x01"), Buffer.alloc(16, 2)]),
    );
    const comment = jpegSegment(0xfe, Buffer.from("noahark"));
    const progressiveMeta = buildProgressiveJpeg([xmp, icc, comment]);
    assertConstructedJpeg(progressiveMeta, 0xc2, 2);
    await accept(progressiveMeta, "image/jpeg");
    await accept(TINY_JPEG, "image/jpeg");
    await accept(jpegWithExif(TINY_JPEG), "image/jpeg");
  });

  it("rejects truncated, trailing and concatenated JPEG payloads", async () => {
    const progressive = buildProgressiveJpeg();
    await deny(progressive.subarray(0, progressive.byteLength - 2));
    await deny(Buffer.concat([progressive, Buffer.from("TRAIL")]));
    await deny(Buffer.concat([progressive, TINY_JPEG]));
    await deny(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it("rejects PNG files that violate IHDR/IDAT/IEND framing", async () => {
    const duplicate = buildPng(
      rgbRows(1, 1, () => [1, 2, 3]),
      1,
      1,
      [pngChunk("IHDR", Buffer.alloc(13, 1))],
    );
    await deny(duplicate);

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const missingIdat = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdr),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    await deny(missingIdat);

    const zeroDim = buildPng(
      rgbRows(1, 1, () => [1, 2, 3]),
      0,
      1,
    );
    await deny(zeroDim);

    const badIend = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", deflateSync(rgbRows(1, 1, () => [1, 2, 3]))),
      pngChunk("IEND", Buffer.from([0x00])),
    ]);
    await deny(badIend);

    const keyword = Buffer.from("XML:com.adobe.xmp\0\0\0\0\0", "utf8");
    const withItxt = buildPng(
      rgbRows(2, 2, () => [10, 20, 30]),
      2,
      2,
      [pngChunk("iTXt", Buffer.concat([keyword, Buffer.from(XMP_PACKET, "utf8")]))],
    );
    await accept(withItxt, "image/png");
  });

  it("rejects a GIF without an image descriptor and accepts a GIF with a comment and image", async () => {
    const headerOnly = Buffer.alloc(14);
    headerOnly.write("GIF89a");
    headerOnly.writeUInt16LE(1, 6);
    headerOnly.writeUInt16LE(1, 8);
    headerOnly[13] = 0x3b;
    await deny(headerOnly);
    await accept(gifWithComment(TINY_GIF), "image/gif");
  });
});
