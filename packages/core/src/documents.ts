/**
 * Packing a document into a message, and getting it back out.
 *
 * Agents should not be doing base64 and gzip by hand. Every one that does will
 * get it slightly differently right -- a different compression level, a
 * different idea of what the checksum covers, a stray newline from a shell
 * pipeline -- and the failures all present as "the file the other agent sent me
 * is corrupt", which is the least diagnosable sentence in this system.
 *
 * So there is one way to do it, on both sides.
 *
 * WEB STREAMS RATHER THAN node:zlib. This is in core, which runs in the Worker
 * as well as in Node, and CompressionStream is in both -- plus browsers, so the
 * dashboard can unpack one without a bundler shim. node:zlib would have made
 * this a Node-only file in a package that is not Node-only.
 *
 * THE CHECKSUM IS OF THE ORIGINAL, before compressing and encoding, because
 * that is the thing the receiver ends up holding. A checksum over the encoded
 * form proves the transfer and says nothing about whether the decode was right.
 */
import { ATTACHMENT_MAX_BYTES, type Attachment } from './schemas.js';

async function drain(
  stream: ReadableStream<Uint8Array>,
  limit = Number.POSITIVE_INFINITY,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    /*
      STOPPED MID-STREAM, not measured afterwards.

      Compression ratios are unbounded: ten megabytes of zeroes gzip to a few
      kilobytes, so an attachment that passes every size check on the way in can
      still expand to gigabytes here. Checking the total after draining means the
      memory is already gone -- the check has to be inside the loop, and it has
      to cancel the reader rather than merely stop reading.

      The sender is another agent, which is exactly the threat model where
      "nobody would do that" is not an argument.
    */
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new DocumentTooLarge(total, total);
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return drain(stream as ReadableStream<Uint8Array>);
}

export async function gunzip(
  bytes: Uint8Array,
  limit = Number.POSITIVE_INFINITY,
): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return drain(stream as ReadableStream<Uint8Array>, limit);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Base64 without pulling in Buffer, so this stays portable. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000; // Chunked: apply() on a megabyte-long array overflows the stack.
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export class DocumentTooLarge extends Error {
  constructor(
    readonly encodedBytes: number,
    readonly originalBytes: number,
  ) {
    super(
      `That document is ${Math.round(encodedBytes / 1024)}KB once compressed and encoded, ` +
        `over the ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB a message can carry. ` +
        'Send the part that matters, or split it.',
    );
    this.name = 'DocumentTooLarge';
  }
}

/**
 * Compress and encode a document so it can travel on a message.
 *
 * REFUSES rather than truncating, the same rule a response body follows: half a
 * document that reports success is worse than a refusal, because the receiver
 * cannot tell.
 */
export async function packDocument(
  bytes: Uint8Array,
  name: string,
  mediaType = 'application/octet-stream',
): Promise<Attachment> {
  const sha256 = await sha256Hex(bytes);
  const content = toBase64(await gzip(bytes));
  if (content.length > ATTACHMENT_MAX_BYTES) {
    throw new DocumentTooLarge(content.length, bytes.length);
  }
  return {
    name,
    media_type: mediaType,
    encoding: 'gzip+base64',
    bytes: bytes.length,
    sha256,
    content,
  };
}

export class DocumentCorrupt extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      'That document did not survive the trip: its checksum does not match what ' +
        `the sender recorded (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…). ` +
        'Ask for it again rather than using it.',
    );
    this.name = 'DocumentCorrupt';
  }
}

/**
 * Decode and decompress, and REFUSE a document that does not match its checksum.
 *
 * Checked rather than reported, because a caller handed bytes and a warning
 * uses the bytes. The whole reason the sender recorded a checksum is so this
 * side can decline.
 */
export async function unpackDocument(attachment: Attachment): Promise<Uint8Array> {
  /*
    Bounded by what the SENDER SAID it was. The schema caps that in turn, so a
    document cannot claim to be a hundred gigabytes and be believed -- and one
    that expands past its own declared size is either corrupt or hostile, and
    neither is worth finishing.
  */
  const bytes = await gunzip(fromBase64(attachment.content), attachment.bytes);
  const actual = await sha256Hex(bytes);
  if (actual !== attachment.sha256) throw new DocumentCorrupt(attachment.sha256, actual);
  return bytes;
}
