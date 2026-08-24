import { fileTypeFromBuffer } from "file-type";

/**
 * Determines a file's real MIME type from its content, never from the
 * client-supplied filename or Content-Type header (both are attacker-
 * controlled). `file-type` recognizes binary formats by magic bytes; formats
 * with no magic number (plain text, CSV, JSON) fall back to a UTF-8 text
 * probe rather than trusting anything the client sent.
 */
export async function sniffMimeType(buffer: Buffer): Promise<string> {
  const detected = await fileTypeFromBuffer(buffer);
  if (detected) return detected.mime;
  return looksLikeUtf8Text(buffer) ? "text/plain" : "application/octet-stream";
}

function looksLikeUtf8Text(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 1024);
  for (const byte of sample) {
    if (byte === 0) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}
