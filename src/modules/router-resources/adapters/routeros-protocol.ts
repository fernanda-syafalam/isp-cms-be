/**
 * RouterOS API wire protocol (pure encode/decode — no sockets). The API speaks
 * length-prefixed "words" grouped into sentences terminated by a zero-length
 * word. Length is encoded with a variable-width scheme (1–5 bytes) documented
 * at https://help.mikrotik.com/docs/display/ROS/API. Kept dependency-free and
 * pure so the framing is unit-testable without a live device.
 */

/** Encode a word length using RouterOS's variable-width scheme. */
export function encodeLength(len: number): Buffer {
  if (len < 0x80) {
    return Buffer.from([len]);
  }
  if (len < 0x4000) {
    const v = len | 0x8000;
    return Buffer.from([(v >> 8) & 0xff, v & 0xff]);
  }
  if (len < 0x200000) {
    const v = len | 0xc00000;
    return Buffer.from([(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  }
  if (len < 0x10000000) {
    const v = len | 0xe0000000;
    return Buffer.from([(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  }
  return Buffer.from([0xf0, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
}

/** Encode one word: its length prefix followed by its UTF-8 bytes. */
export function encodeWord(word: string): Buffer {
  const body = Buffer.from(word, 'utf8');
  return Buffer.concat([encodeLength(body.length), body]);
}

/**
 * Encode a full sentence: each word length-prefixed, terminated by a
 * zero-length word (a single 0x00 byte).
 */
export function encodeSentence(words: string[]): Buffer {
  return Buffer.concat([...words.map(encodeWord), Buffer.from([0x00])]);
}

/** A decoded length + the offset just past its prefix bytes. */
export type DecodedLength = { length: number; offset: number };

/** Decode a variable-width length starting at `offset`. */
export function decodeLength(buf: Buffer, offset: number): DecodedLength {
  const first = buf[offset] ?? 0;
  if ((first & 0x80) === 0x00) {
    return { length: first, offset: offset + 1 };
  }
  if ((first & 0xc0) === 0x80) {
    return { length: ((first & 0x3f) << 8) | (buf[offset + 1] ?? 0), offset: offset + 2 };
  }
  if ((first & 0xe0) === 0xc0) {
    return {
      length: ((first & 0x1f) << 16) | ((buf[offset + 1] ?? 0) << 8) | (buf[offset + 2] ?? 0),
      offset: offset + 3,
    };
  }
  if ((first & 0xf0) === 0xe0) {
    return {
      length:
        ((first & 0x0f) << 24) |
        ((buf[offset + 1] ?? 0) << 16) |
        ((buf[offset + 2] ?? 0) << 8) |
        (buf[offset + 3] ?? 0),
      offset: offset + 4,
    };
  }
  return {
    length:
      ((buf[offset + 1] ?? 0) << 24) |
      ((buf[offset + 2] ?? 0) << 16) |
      ((buf[offset + 3] ?? 0) << 8) |
      (buf[offset + 4] ?? 0),
    offset: offset + 5,
  };
}

/**
 * Parse as many complete sentences as `buf` holds. Returns the decoded
 * sentences (each an array of words) plus the number of bytes consumed, so a
 * caller can keep the trailing partial bytes for the next chunk.
 */
export function parseSentences(buf: Buffer): { sentences: string[][]; consumed: number } {
  const sentences: string[][] = [];
  let words: string[] = [];
  let offset = 0;
  let sentenceStart = 0;

  while (offset < buf.length) {
    const { length, offset: bodyStart } = decodeLength(buf, offset);
    if (length === 0) {
      // End of a sentence.
      sentences.push(words);
      words = [];
      offset = bodyStart;
      sentenceStart = offset;
      continue;
    }
    if (bodyStart + length > buf.length) {
      // Word body not fully arrived yet — stop before this sentence.
      break;
    }
    words.push(buf.toString('utf8', bodyStart, bodyStart + length));
    offset = bodyStart + length;
  }

  return { sentences, consumed: sentenceStart };
}
