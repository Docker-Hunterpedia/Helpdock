import { describe, expect, it } from 'vitest';
import { encodeQr, sizeOf } from './qr-encode.js';

/**
 * Reading a symbol back the way a scanner does: find the mask in the format
 * string, undo it, walk the zigzag in reverse, and see whether the mode, the
 * length and the text come back out.
 *
 * It is a separate file from `qr-encode.test.ts` because it is a separate
 * claim. That file checks the encoder against the published tables — the format
 * strings, the version strings, the Reed-Solomon example in annex I — which is
 * what proves the parts are right. This one is the end-to-end statement that a
 * reader holding nothing but the specification gets the text back, which is the
 * only thing a person pointing a phone at the screen cares about.
 *
 * Everything below is written out rather than imported from the encoder, so
 * that it is a second opinion and not a restatement of the first.
 */

/** ISO/IEC 18004 table C.1, the rows for error-correction level M. */
const FORMAT_STRINGS_M = [
  0b101010000010010, 0b101000100100101, 0b101111001111100, 0b101101101001011, 0b100010111111001,
  0b100000011001110, 0b100111110010111, 0b100101010100000,
];

const MASK_FUNCTIONS: readonly ((row: number, column: number) => boolean)[] = [
  (row, column) => (row + column) % 2 === 0,
  (row) => row % 2 === 0,
  (_row, column) => column % 3 === 0,
  (row, column) => (row + column) % 3 === 0,
  (row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
  (row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
  (row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
  (row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0,
];

/**
 * Where a version-1 symbol's function patterns are, from the specification
 * alone: three finders with their separators, the two timing lines, and the
 * format-information areas with the module that is always dark.
 */
const functionModulesOfVersion1 = (): boolean[][] => {
  const size = sizeOf(1);
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (row: number, column: number): void => {
    const line = reserved[row];
    if (line !== undefined && column >= 0 && column < size) {
      line[column] = true;
    }
  };

  for (const [top, left] of [
    [0, 0],
    [0, size - 8],
    [size - 8, 0],
  ] as const) {
    for (let row = top; row < top + 8; row += 1) {
      for (let column = left; column < left + 8; column += 1) {
        mark(row, column);
      }
    }
  }

  for (let index = 0; index < size; index += 1) {
    mark(6, index);
    mark(index, 6);
  }

  for (let index = 0; index <= 8; index += 1) {
    mark(index, 8);
    mark(8, index);
  }
  for (let index = 0; index < 8; index += 1) {
    mark(8, size - 1 - index);
    mark(size - 1 - index, 8);
  }

  return reserved;
};

describe('reading a version-1 symbol back', () => {
  it('recovers the mode, the length and the text', () => {
    const matrix = encodeQr('HELLO');
    const size = matrix.length;
    expect(size).toBe(sizeOf(1));

    const formatBits = [
      ...Array.from({ length: 6 }, (_unused, index) => matrix[index]?.[8] === true),
      matrix[7]?.[8] === true,
      matrix[8]?.[8] === true,
      matrix[8]?.[7] === true,
      ...Array.from({ length: 6 }, (_unused, index) => matrix[8]?.[5 - index] === true),
    ].reduce((value, dark, index) => (dark ? value | (1 << index) : value), 0);

    const mask = FORMAT_STRINGS_M.indexOf(formatBits);
    expect(mask).toBeGreaterThanOrEqual(0);
    const shouldFlip = MASK_FUNCTIONS[mask];
    expect(shouldFlip).toBeDefined();

    const reserved = functionModulesOfVersion1();
    const bits: boolean[] = [];
    let upward = true;

    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) {
        right = 5;
      }

      for (let step = 0; step < size; step += 1) {
        const row = upward ? size - 1 - step : step;

        for (const column of [right, right - 1]) {
          if (reserved[row]?.[column] === true) {
            continue;
          }

          const stored = matrix[row]?.[column] === true;
          bits.push(shouldFlip?.(row, column) === true ? !stored : stored);
        }
      }

      upward = !upward;
    }

    const codewords: number[] = [];
    for (let index = 0; index + 8 <= bits.length; index += 8) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit += 1) {
        byte = (byte << 1) | (bits[index + bit] === true ? 1 : 0);
      }
      codewords.push(byte);
    }

    /**
     * Version 1 at level M is a single block of 16 data codewords, so there is
     * no interleaving to undo: mode `0100`, an 8-bit length of 5, the five
     * bytes of "HELLO", a four-bit terminator, and then the two pad codewords
     * alternating from `0xEC`.
     */
    expect(codewords.slice(0, 16)).toEqual([
      0x40, 0x54, 0x84, 0x54, 0xc4, 0xc4, 0xf0, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11,
      0xec,
    ]);
  });
});
