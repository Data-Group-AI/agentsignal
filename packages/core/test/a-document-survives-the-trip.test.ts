import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_ORIGINAL_BYTES,
  DocumentCorrupt,
  DocumentTooLarge,
  attachmentSchema,
  packDocument,
  unpackDocument,
} from '../src/index.js';

/**
 * A DOCUMENT SURVIVES THE TRIP.
 *
 * Agents were doing this by hand or not at all: a response was a choice between
 * three forty-character options, so anything an agent actually produced stayed
 * on its own machine. The point of packing it here rather than in each agent is
 * that every hand-rolled version gets it slightly differently right, and all of
 * those failures present as "the file the other agent sent me is corrupt".
 */

const text = (s: string) => new TextEncoder().encode(s);

describe('a document survives the trip', () => {
  it('comes back byte for byte', async () => {
    const original = text('# Report\n\nEverything passed.\n'.repeat(200));
    const packed = await packDocument(original, 'report.md', 'text/markdown');
    const back = await unpackDocument(packed);

    expect(back).toEqual(original);
    expect(packed.name).toBe('report.md');
    expect(packed.media_type).toBe('text/markdown');
    expect(packed.bytes).toBe(original.length);
  });

  it('actually compresses, which is the whole reason to do this', async () => {
    // Repetitive text is the realistic case: logs, reports, diffs.
    const original = text('the same line over and over\n'.repeat(500));
    const packed = await packDocument(original, 'log.txt');

    /*
      Asserted as a RATIO rather than a fixed size. A number here would be a
      guess about gzip that a future runtime could invalidate, and the claim
      worth defending is only that compressing helped -- not by how much.
    */
    expect(packed.content.length).toBeLessThan(original.length / 2);
  });

  it('survives bytes that are not text', async () => {
    const original = new Uint8Array(4096);
    for (let i = 0; i < original.length; i += 1) original[i] = (i * 7) % 256;

    expect(await unpackDocument(await packDocument(original, 'blob.bin'))).toEqual(original);
  });

  /** The empty file is the edge every encoder gets wrong once. */
  it('handles an empty document', async () => {
    const packed = await packDocument(new Uint8Array(0), 'nothing.txt');
    expect(packed.bytes).toBe(0);
    expect((await unpackDocument(packed)).length).toBe(0);
  });

  /**
   * The checksum exists so this side can DECLINE. A caller handed bytes and a
   * warning uses the bytes.
   */
  it('refuses a document that did not survive, rather than reporting it', async () => {
    const packed = await packDocument(text('the real thing'), 'real.txt');
    const tampered = { ...packed, sha256: 'a'.repeat(64) };

    await expect(unpackDocument(tampered)).rejects.toBeInstanceOf(DocumentCorrupt);
  });

  it('refuses one that is too large rather than truncating it', async () => {
    /*
      GENUINELY INCOMPRESSIBLE, and a first draft of this was not. It filled the
      array from a linear congruential generator, whose low bits are highly
      predictable -- gzip squashed it and the pack succeeded, so the test failed
      while the code was right. crypto.getRandomValues has no such pattern, and
      caps at 65536 bytes per call, hence the chunking.

      The ceiling is on the ENCODED size, so this has to be big enough that
      gzip-then-base64 still exceeds it: base64 adds a third, so a shade over
      8MB of incompressible input clears 10MB encoded.
    */
    const big = new Uint8Array(Math.ceil(ATTACHMENT_MAX_BYTES * 0.8) + 65536);
    for (let i = 0; i < big.length; i += 65536) {
      crypto.getRandomValues(big.subarray(i, Math.min(i + 65536, big.length)));
    }

    await expect(packDocument(big, 'huge.bin')).rejects.toBeInstanceOf(DocumentTooLarge);
  }, 60_000);

  /**
   * THE ZIP BOMB. Ten megabytes of zeroes compress to a few kilobytes, so an
   * attachment can pass every check on the way in and still try to become
   * gigabytes in the receiver's memory. The sender is another agent, which is
   * exactly the case where "nobody would do that" is not an argument.
   */
  it('refuses to expand a document past the size it claims to be', async () => {
    const zeroes = new Uint8Array(2 * 1024 * 1024);
    const honest = await packDocument(zeroes, 'bomb.bin');

    // Tiny on the wire -- which is the whole trick.
    expect(honest.content.length).toBeLessThan(64 * 1024);

    // It now claims to be small while carrying two megabytes.
    const lying = { ...honest, bytes: 1024 };
    await expect(unpackDocument(lying)).rejects.toBeInstanceOf(DocumentTooLarge);
  }, 30_000);

  it('will not believe a declared size beyond the ceiling', async () => {
    const packed = await packDocument(text('small'), 'small.txt');
    const absurd = { ...packed, bytes: ATTACHMENT_MAX_ORIGINAL_BYTES + 1 };
    expect(attachmentSchema.safeParse(absurd).success).toBe(false);
  });

  it('produces something the schema accepts', async () => {
    const packed = await packDocument(text('hello'), 'hello.txt', 'text/plain');
    expect(attachmentSchema.safeParse(packed).success).toBe(true);
  });

  /**
   * The name arrives from another machine and gets joined to a directory by
   * whoever saves it. Refused here, once, rather than trusting every consumer
   * to remember basename.
   */
  it('refuses a name that is really a path', async () => {
    const packed = await packDocument(text('x'), 'fine.txt');
    for (const name of [
      '../../.ssh/authorized_keys',
      '/etc/passwd',
      'sub/dir/file.txt',
      '..\\..\\windows\\system32',
      '.',
      '..',
    ]) {
      expect(
        attachmentSchema.safeParse({ ...packed, name }).success,
        `accepted ${JSON.stringify(name)} as a name`,
      ).toBe(false);
    }

    // And an ordinary name with a dot in it is still fine.
    expect(attachmentSchema.safeParse({ ...packed, name: 'report.2026-08-21.md' }).success)
      .toBe(true);
  });

  /** A shape that is nearly right is how a bad encoder gets accepted. */
  it('rejects a shape that is nearly right', async () => {
    const packed = await packDocument(text('hello'), 'hello.txt');
    expect(attachmentSchema.safeParse({ ...packed, encoding: 'base64' }).success).toBe(false);
    expect(attachmentSchema.safeParse({ ...packed, sha256: 'NOTHEX' }).success).toBe(false);
    expect(attachmentSchema.safeParse({ ...packed, sha256: packed.sha256.toUpperCase() }).success)
      .toBe(false);
  });
});
