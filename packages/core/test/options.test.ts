import { describe, expect, it } from 'vitest';
import { sendMessageSchema } from '../src/schemas.js';

/**
 * A question's answers, arriving as an array or as a JSON-encoded one.
 *
 * The second form is not a convenience. The Pilot app catalogue types every
 * parameter as string, int, number, bool or object, and an array declared as
 * `object` is rejected -- so on that surface the choice was a string or no
 * questions at all, and ask/answer is half of what agent-to-agent
 * coordination is for.
 *
 * What these tests are really guarding is that widening the door did not move
 * the wall: every limit that applied to the array still applies to the string,
 * because a caller who cannot express an array is exactly the caller least
 * able to tell why their message was refused.
 */

const base = { to: 'u_TfLMauNRMzrXuHKqZU4M2I', body: 'pick one' };
const parse = (options?: unknown) =>
  sendMessageSchema.safeParse(options === undefined ? base : { ...base, options });

describe('answers as an array, which is what every existing caller sends', () => {
  it('still works, unchanged', () => {
    const result = parse(['Roll back', 'Hold', 'Ship it']);
    expect(result.success).toBe(true);
    expect(result.data!.options).toEqual(['Roll back', 'Hold', 'Ship it']);
  });

  it('is still absent when absent, rather than becoming an empty question', () => {
    const result = parse();
    expect(result.success).toBe(true);
    // A message with `options: []` is a question nobody can answer. Undefined
    // is what makes it an ordinary notification instead.
    expect(result.data!.options).toBeUndefined();
  });
});

describe('answers as a JSON-encoded array, for a caller with no array type', () => {
  it('parses to exactly what the array form produces', () => {
    const asString = parse('["Roll back","Hold","Ship it"]');
    const asArray = parse(['Roll back', 'Hold', 'Ship it']);

    expect(asString.success).toBe(true);
    // Equal to the array form, not merely "an array of three things". If the
    // two forms diverge, one of them is wrong and nobody finds out until a
    // recipient taps the wrong button.
    expect(asString.data!.options).toEqual(asArray.data!.options);
  });

  it('keeps a comma inside an answer intact', () => {
    // The reason this is JSON rather than a comma-separated list. An answer is
    // free text up to forty characters and "Yes, ship it" is an ordinary thing
    // to offer; splitting on commas would show three options where two were
    // meant, silently, with the wrong text on each.
    const result = parse('["Yes, ship it","No"]');
    expect(result.success).toBe(true);
    expect(result.data!.options).toEqual(['Yes, ship it', 'No']);
  });

  it('trims each answer, exactly as the array form does', () => {
    const result = parse('["  Hold  ","Ship"]');
    expect(result.data!.options).toEqual(['Hold', 'Ship']);
  });
});

describe('the limits did not move', () => {
  it('refuses a fourth answer, whichever form it arrived in', () => {
    // Three is what fits in a row of buttons. A string that smuggles in four
    // would render a question the recipient cannot fully see.
    expect(parse(['a', 'b', 'c', 'd']).success).toBe(false);
    expect(parse('["a","b","c","d"]').success).toBe(false);
  });

  it('refuses an answer longer than forty characters in either form', () => {
    const tooLong = 'x'.repeat(41);
    expect(parse([tooLong]).success).toBe(false);
    expect(parse(JSON.stringify([tooLong])).success).toBe(false);
  });

  it('refuses an empty list in either form', () => {
    expect(parse([]).success).toBe(false);
    expect(parse('[]').success).toBe(false);
  });
});

describe('what a string that is not a JSON array does', () => {
  it('refuses a bare comma-separated list, and says what to send', () => {
    const result = parse('Roll back, Hold');
    expect(result.success).toBe(false);
    // Refused rather than guessed at. The guess would be one option named
    // "Roll back, Hold" -- a question with a single answer, which is not what
    // anybody typing that meant.
    expect(JSON.stringify(result.error!.issues)).toMatch(/JSON-encoded array/);
  });

  it('refuses JSON that is not an array of strings', () => {
    expect(parse('{"a":1}').success).toBe(false);
    expect(parse('"just a string"').success).toBe(false);
    expect(parse('[1,2,3]').success).toBe(false);
  });

  it('refuses a truncated JSON array rather than throwing', () => {
    // A caller that built the string by hand can easily send this, and an
    // uncaught JSON.parse here would be a 500 on a validation problem.
    const result = parse('["Roll back",');
    expect(result.success).toBe(false);
  });
});
