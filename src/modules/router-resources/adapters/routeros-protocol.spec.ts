import { describe, expect, it } from 'vitest';
import {
  decodeLength,
  encodeLength,
  encodeSentence,
  encodeWord,
  parseSentences,
} from './routeros-protocol';

describe('routeros-protocol', () => {
  describe('encodeLength / decodeLength', () => {
    // Boundary values of each width band in the RouterOS length scheme.
    const cases = [0, 1, 0x7f, 0x80, 0x3fff, 0x4000, 0x1fffff, 0x200000, 0xfffffff];

    it('round-trips each width band', () => {
      for (const len of cases) {
        const encoded = encodeLength(len);
        const { length, offset } = decodeLength(encoded, 0);
        expect(length).toBe(len);
        expect(offset).toBe(encoded.length);
      }
    });

    it('uses one byte below 0x80 and two bytes at 0x80', () => {
      expect(encodeLength(0x7f)).toHaveLength(1);
      expect(encodeLength(0x80)).toHaveLength(2);
    });
  });

  describe('encodeWord', () => {
    it('prefixes the utf-8 body with its length', () => {
      const encoded = encodeWord('/login');
      expect(encoded[0]).toBe(6);
      expect(encoded.subarray(1).toString('utf8')).toBe('/login');
    });
  });

  describe('encodeSentence + parseSentences', () => {
    it('round-trips a full sentence terminated by a zero word', () => {
      const words = ['/ppp/secret/set', '=.id=*1', '=disabled=yes'];
      const buf = encodeSentence(words);
      // A sentence ends with a single zero byte.
      expect(buf[buf.length - 1]).toBe(0x00);

      const { sentences, consumed } = parseSentences(buf);
      expect(sentences).toEqual([words]);
      expect(consumed).toBe(buf.length);
    });

    it('parses multiple sentences and keeps a trailing partial for the next chunk', () => {
      const complete = encodeSentence(['!re', '=.id=*7']);
      const partial = encodeWord('!done').subarray(0, 2); // half of the next sentence
      const { sentences, consumed } = parseSentences(Buffer.concat([complete, partial]));

      expect(sentences).toEqual([['!re', '=.id=*7']]);
      // Only the complete sentence is consumed; the partial bytes remain.
      expect(consumed).toBe(complete.length);
    });
  });
});
