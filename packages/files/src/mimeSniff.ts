import { fileTypeFromBuffer } from "file-type";
import { ValidationError } from "@noahark/core";

/**
 * Determines a file's real MIME type from its content, never from the
 * client-supplied filename or Content-Type header (both are attacker-
 * controlled). `file-type` recognizes binary formats by magic bytes; formats
 * with no magic number (plain text, CSV) fall back to a UTF-8 text
 * probe rather than trusting anything the client sent.
 *
 * HTML / SVG / XML / JavaScript that would otherwise classify as
 * `text/plain` are labelled as themselves so the upload allowlist can
 * reject them. Generic ZIP and OOXML are left as the detector's type and
 * are not allowlisted (T-14 defers OOXML until ZIP contents are proven).
 *
 * Active-text heuristics run only for `text/plain` and `text/csv`. They are
 * never applied to PDF/PNG/JPEG/GIF/WebP bytes. Those types are checked
 * with bounded, format-aware framing instead (header/chunk/marker
 * structure and credible termination). These are not full media decoders:
 * PNG CRC values are not verified; JPEG Huffman/quant tables are not
 * interpreted; GIF pixels, WebP payloads and PDF objects are not decoded.
 *
 * For accepted text, the complete bounded buffer is decoded as UTF-8
 * (BOM stripped; invalid UTF-8 fails closed) and inspected with a small
 * fixed number of linear O(n) passes. A `<` immediately followed by an
 * XML NameStart character, `!`, `?` or `/` is markup and is rejected,
 * including comment openers (`<!--`) and namespace-prefixed names such
 * as `<_:svg`. Comments are not stripped and tag-wide wildcard regexes
 * are not used. Comparison prose such as `a < b` remains eligible.
 * Unsafe C0 controls other than TAB/LF/CR fail closed. Contents are
 * never logged.
 *
 * Limitation (narrowed text grammar, fail-closed): arbitrary JavaScript
 * without markup, a shebang, `import`/`export`, or a `function` declaration
 * cannot be reliably distinguished from unrestricted plain text (e.g.
 * `alert(1)`). This classifier does not claim complete JavaScript detection.
 */
export async function sniffMimeType(buffer: Buffer): Promise<string> {
  if (buffer.byteLength === 0) return "application/octet-stream";
  const detected = await fileTypeFromBuffer(buffer);
  if (detected) {
    if (isAllowlistedBinary(detected.mime)) {
      return isStructurallyValidBinary(detected.mime, buffer)
        ? detected.mime
        : "application/octet-stream";
    }
    return detected.mime;
  }
  if (!looksLikeUtf8Text(buffer)) return "application/octet-stream";
  return classifyUtf8Text(buffer);
}

const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/csv",
]);

const ALLOWLISTED_BINARY_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * Fail-closed upload allowlist. Call after `sniffMimeType`. Never trusts
 * the client Content-Type, filename, or extension. Does not log bytes.
 * Text heuristics apply only to sniffed/claimed text types. Binary types
 * require structural validation of that format.
 */
export function assertAllowedUploadMime(mimeType: string, buffer: Buffer): void {
  if (buffer.byteLength === 0) {
    throw new ValidationError("Cannot upload an empty file");
  }
  if (!ALLOWED_UPLOAD_MIME_TYPES.has(mimeType)) {
    throw new ValidationError("File type is not allowed");
  }
  if (mimeType === "text/plain" || mimeType === "text/csv") {
    if (deniedTextPayload(buffer)) {
      throw new ValidationError("File type is not allowed");
    }
    return;
  }
  if (!isStructurallyValidBinary(mimeType, buffer)) {
    throw new ValidationError("File type is not allowed");
  }
}

function isAllowlistedBinary(mimeType: string): boolean {
  return ALLOWLISTED_BINARY_MIME_TYPES.has(mimeType);
}

function isStructurallyValidBinary(mimeType: string, buffer: Buffer): boolean {
  switch (mimeType) {
    case "application/pdf":
      return isStructurallyValidPdf(buffer);
    case "image/png":
      return isStructurallyValidPng(buffer);
    case "image/jpeg":
      return isStructurallyValidJpeg(buffer);
    case "image/gif":
      return isStructurallyValidGif(buffer);
    case "image/webp":
      return isStructurallyValidWebp(buffer);
    default:
      return false;
  }
}

/**
 * Framing check only: header `%PDF-n.n` at byte 0 and a final `%%EOF`
 * with only whitespace after. Objects, xref tables and streams are not
 * decoded.
 */
function isStructurallyValidPdf(buffer: Buffer): boolean {
  if (buffer.byteLength < 8) return false;
  const header = buffer.subarray(0, 8).toString("latin1");
  if (!/^%PDF-\d\.\d/.test(header)) return false;
  const eof = buffer.lastIndexOf(Buffer.from("%%EOF", "latin1"));
  if (eof === -1) return false;
  for (let i = eof + 5; i < buffer.byteLength; i += 1) {
    const b = buffer[i];
    if (
      b !== 0x00 &&
      b !== 0x09 &&
      b !== 0x0a &&
      b !== 0x0c &&
      b !== 0x0d &&
      b !== 0x20
    ) {
      return false;
    }
  }
  return true;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Framing check only: signature, exactly one IHDR (first, length 13,
 * non-zero width/height), at least one IDAT, IEND of length 0, and no
 * bytes after IEND. Chunk CRC values are not verified.
 */
function isStructurallyValidPng(buffer: Buffer): boolean {
  if (buffer.byteLength < 33) return false;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let offset = 8;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;
  let chunkIndex = 0;
  while (offset + 12 <= buffer.byteLength) {
    const start = offset;
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("latin1");
    if (offset + 12 + length > buffer.byteLength) return false;
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (chunkIndex === 0) {
      if (type !== "IHDR" || length !== 13) return false;
      const width = buffer.readUInt32BE(offset + 8);
      const height = buffer.readUInt32BE(offset + 12);
      if (width === 0 || height === 0) return false;
      sawIhdr = true;
    } else if (type === "IHDR") {
      return false;
    }
    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") {
      if (length !== 0) return false;
      sawIend = true;
      offset += 12;
      break;
    }
    offset += 12 + length;
    if (offset <= start) return false;
    chunkIndex += 1;
  }
  return sawIhdr && sawIdat && sawIend && offset === buffer.byteLength;
}

/**
 * Framing check only: SOI, marker/segment lengths, one or more SOS
 * entropy-coded scans (baseline or progressive), and a terminal EOI with
 * no trailing bytes. Huffman/quantization tables and pixel data are not
 * decoded. Concatenated second images after EOI are rejected.
 */
function isStructurallyValidJpeg(buffer: Buffer): boolean {
  if (buffer.byteLength < 4) return false;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return false;
  let i = 2;
  let sawEoi = false;
  while (i < buffer.byteLength) {
    const start = i;
    if (buffer[i] !== 0xff) return false;
    while (i < buffer.byteLength && buffer[i] === 0xff) i += 1;
    if (i >= buffer.byteLength) return false;
    const marker = buffer[i];
    if (marker === undefined) return false;
    i += 1;
    if (marker === 0xd8) return false;
    if (marker === 0xd9) {
      sawEoi = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      if (i <= start) return false;
      continue;
    }
    if (i + 2 > buffer.byteLength) return false;
    const length = buffer.readUInt16BE(i);
    if (length < 2 || i + length > buffer.byteLength) return false;
    i += length;
    if (marker === 0xda) {
      const afterScan = skipJpegEntropy(buffer, i);
      if (afterScan === undefined || afterScan < i) return false;
      i = afterScan;
    }
    if (i <= start) return false;
  }
  return sawEoi && i === buffer.byteLength;
}

function skipJpegEntropy(buffer: Buffer, start: number): number | undefined {
  let i = start;
  while (i < buffer.byteLength) {
    if (buffer[i] !== 0xff) {
      i += 1;
      continue;
    }
    if (i + 1 >= buffer.byteLength) return undefined;
    const next = buffer[i + 1];
    if (next === undefined) return undefined;
    if (next === 0x00) {
      i += 2;
      continue;
    }
    if (next >= 0xd0 && next <= 0xd7) {
      i += 2;
      continue;
    }
    if (next === 0xff) {
      i += 1;
      continue;
    }
    return i;
  }
  return undefined;
}

function skipGifSubBlocks(buffer: Buffer, start: number): number | undefined {
  let offset = start;
  while (offset < buffer.byteLength) {
    const size = buffer[offset];
    if (size === undefined) return undefined;
    if (size === 0) return offset + 1;
    if (offset + 1 + size > buffer.byteLength) return undefined;
    offset += 1 + size;
  }
  return undefined;
}

/**
 * Framing check only: GIF87a/GIF89a, global/local colour tables,
 * extensions/sub-blocks, at least one image descriptor, and a terminal
 * trailer with no trailing bytes. Pixels are not decoded.
 */
function isStructurallyValidGif(buffer: Buffer): boolean {
  if (buffer.byteLength < 14) return false;
  const header = buffer.subarray(0, 6).toString("latin1");
  if (header !== "GIF87a" && header !== "GIF89a") return false;
  const packed = buffer[10] ?? 0;
  let offset = 13;
  if (packed & 0x80) {
    const gctSize = 3 * (1 << ((packed & 7) + 1));
    if (offset + gctSize > buffer.byteLength) return false;
    offset += gctSize;
  }
  let sawImage = false;
  while (offset < buffer.byteLength) {
    const start = offset;
    const introducer = buffer[offset];
    if (introducer === 0x3b) return sawImage && offset + 1 === buffer.byteLength;
    if (introducer === 0x21) {
      if (offset + 2 > buffer.byteLength) return false;
      const next = skipGifSubBlocks(buffer, offset + 2);
      if (next === undefined) return false;
      offset = next;
    } else if (introducer === 0x2c) {
      if (offset + 10 > buffer.byteLength) return false;
      const localPacked = buffer[offset + 9] ?? 0;
      offset += 10;
      if (localPacked & 0x80) {
        const lctSize = 3 * (1 << ((localPacked & 7) + 1));
        if (offset + lctSize > buffer.byteLength) return false;
        offset += lctSize;
      }
      if (offset >= buffer.byteLength) return false;
      offset += 1;
      const next = skipGifSubBlocks(buffer, offset);
      if (next === undefined) return false;
      offset = next;
      sawImage = true;
    } else {
      return false;
    }
    if (offset <= start) return false;
  }
  return false;
}

/**
 * Framing check only: RIFF/WEBP declared size equals the buffer, chunk
 * boundaries are internally consistent, and at least one image chunk is
 * present. VP8/VP8L/VP8X payloads, animation frames and ICC/EXIF/XMP
 * bodies are not decoded.
 */
function isStructurallyValidWebp(buffer: Buffer): boolean {
  if (buffer.byteLength < 20) return false;
  if (buffer.subarray(0, 4).toString("latin1") !== "RIFF") return false;
  if (buffer.subarray(8, 12).toString("latin1") !== "WEBP") return false;
  const riffSize = buffer.readUInt32LE(4);
  if (8 + riffSize !== buffer.byteLength) return false;
  let offset = 12;
  let sawImage = false;
  while (offset + 8 <= buffer.byteLength) {
    const start = offset;
    const type = buffer.subarray(offset, offset + 4).toString("latin1");
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const padded = size + (size % 2);
    if (dataStart + padded > buffer.byteLength) return false;
    if (!/^[A-Za-z0-9 ]{4}$/.test(type)) return false;
    if (type === "VP8 " || type === "VP8L" || type === "VP8X") sawImage = true;
    offset = dataStart + padded;
    if (offset <= start) return false;
  }
  return sawImage && offset === buffer.byteLength;
}

function looksLikeUtf8Text(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function classifyUtf8Text(buffer: Buffer): string {
  const text = decodeUtf8Text(buffer);
  if (text === undefined) return "application/octet-stream";
  if (textContainsDeniedMarkupOrScript(text)) return "text/html";
  if (looksLikeCsvText(text)) return "text/csv";
  return "text/plain";
}

function deniedTextPayload(buffer: Buffer): boolean {
  const text = decodeUtf8Text(buffer);
  if (text === undefined) return true;
  return textContainsDeniedMarkupOrScript(text) || textContainsUnsafeControls(text);
}

function decodeUtf8Text(buffer: Buffer): string | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function isUnsafeC0(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  return code < 0x20;
}

/**
 * Markup opener after `<`: XML 1.0 NameStartChar, plus `!`, `?` and `/`
 * for comments, declarations, PIs and end-tags. Constant-time per `<`.
 * https://www.w3.org/TR/xml/#NT-NameStartChar
 */
function isMarkupStartAt(text: string, index: number): boolean {
  if (index >= text.length) return false;
  const c = text.charCodeAt(index);
  if (c === 0x21 || c === 0x2f || c === 0x3a || c === 0x3f || c === 0x5f) {
    return true;
  }
  if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) return true;
  if (c >= 0xc0 && c <= 0xd6) return true;
  if (c >= 0xd8 && c <= 0xf6) return true;
  if (c >= 0xf8 && c <= 0x2ff) return true;
  if (c >= 0x370 && c <= 0x37d) return true;
  if (c >= 0x37f && c <= 0x1fff) return true;
  if (c === 0x200c || c === 0x200d) return true;
  if (c >= 0x2070 && c <= 0x218f) return true;
  if (c >= 0x2c00 && c <= 0x2fef) return true;
  if (c >= 0x3001 && c <= 0xd7ff) return true;
  if (c >= 0xf900 && c <= 0xfdcf) return true;
  if (c >= 0xfdf0 && c <= 0xfffd) return true;
  if (c >= 0xd800 && c <= 0xdbff && index + 1 < text.length) {
    const low = text.charCodeAt(index + 1);
    if (low >= 0xdc00 && low <= 0xdfff) {
      const cp = ((c - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
      return cp <= 0xeffff;
    }
  }
  return false;
}

function textContainsUnsafeControls(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (isUnsafeC0(text.charCodeAt(i))) return true;
  }
  return false;
}

function textContainsDeniedMarkupOrScript(text: string): boolean {
  if (textContainsUnsafeControls(text)) return true;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 0x3c) continue;
    if (isMarkupStartAt(text, i + 1)) return true;
  }
  return textLooksLikeJavascript(text);
}

function skipHorizontalAndLineSpace(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0xfeff) {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

function hasPrefixAt(text: string, index: number, prefix: string): boolean {
  if (index + prefix.length > text.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (text.charCodeAt(index + i) !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

function hasInsensitivePrefixAt(text: string, index: number, prefix: string): boolean {
  if (index + prefix.length > text.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    const actual = text.charCodeAt(index + i);
    const expected = prefix.charCodeAt(i);
    if (actual === expected) continue;
    if (actual >= 0x41 && actual <= 0x5a && actual + 32 === expected) continue;
    if (actual >= 0x61 && actual <= 0x7a && actual - 32 === expected) continue;
    return false;
  }
  return true;
}

function textLooksLikeJavascript(text: string): boolean {
  const start = skipHorizontalAndLineSpace(text, 0);
  if (hasInsensitivePrefixAt(text, start, "javascript")) {
    const after = skipHorizontalAndLineSpace(text, start + 10);
    if (text.charCodeAt(after) === 0x3a) return true;
  }
  if (hasPrefixAt(text, start, "#!/")) return true;
  if (hasPrefixAt(text, start, "function")) {
    let i = start + 8;
    if (i < text.length && (text.charCodeAt(i) === 0x20 || text.charCodeAt(i) === 0x09)) {
      i = skipHorizontalAndLineSpace(text, i);
      const c = text.charCodeAt(i);
      if (
        (c >= 0x41 && c <= 0x5a) ||
        (c >= 0x61 && c <= 0x7a) ||
        c === 0x5f ||
        c === 0x24
      ) {
        return true;
      }
    }
  }
  for (let i = start; i < text.length; i += 1) {
    if (
      i !== start &&
      text.charCodeAt(i - 1) !== 0x0a &&
      text.charCodeAt(i - 1) !== 0x0d
    ) {
      continue;
    }
    if (hasPrefixAt(text, i, "import") || hasPrefixAt(text, i, "export")) {
      const after = i + 6;
      const c = text.charCodeAt(after);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) return true;
    }
  }
  return false;
}

function looksLikeCsvText(text: string): boolean {
  if (textContainsDeniedMarkupOrScript(text)) return false;
  let i = 0;
  let sawComma = false;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x0a || c === 0x0d) break;
    if (c === 0x2c) sawComma = true;
    i += 1;
  }
  return sawComma && i > 0;
}
