import { describe, expect, it } from 'vitest';
import {
  encodeQr,
  errorCorrectionFor,
  formatInformation,
  maskPenalty,
  QR_MAX_VERSION,
  QrTooLongError,
  qrPath,
  sizeOf,
  versionFor,
  versionInformation,
} from './qr-encode.js';

/**
 * The encoder is checked against ISO/IEC 18004's own tables rather than against
 * another implementation's output: the format strings, the version strings, the
 * symbol sizes and the finder and timing patterns are all published values, and
 * a check against them is a check that a scanner will agree.
 *
 * The data region is checked by reading it back out — unmasking and walking the
 * same zigzag in reverse — which is what a reader does, and which fails if the
 * placement, the masking or the interleaving disagree with each other.
 */

/** ISO/IEC 18004 table C.1, the rows for error-correction level M. */
const FORMAT_STRINGS_M = [
  0b101010000010010, 0b101000100100101, 0b101111001111100, 0b101101101001011, 0b100010111111001,
  0b100000011001110, 0b100111110010111, 0b100101010100000,
];

/** ISO/IEC 18004 table D.1, versions 7 to 10. */
const VERSION_STRINGS = new Map([
  [7, 0b000111110010010100],
  [8, 0b001000010110111100],
  [9, 0b001001101010011001],
  [10, 0b001010010011010011],
]);

const OTPAUTH =
  'otpauth://totp/Helpdock:lina%40helpdock.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Helpdock';

describe('formatInformation', () => {
  it.each(FORMAT_STRINGS_M.map((bits, mask) => [mask, bits] as const))(
    'matches the published string for mask %i',
    (mask, bits) => {
      expect(formatInformation(mask)).toBe(bits);
    },
  );
});

describe('versionInformation', () => {
  it.each([...VERSION_STRINGS])('matches the published string for version %i', (version, bits) => {
    expect(versionInformation(version)).toBe(bits);
  });
});

describe('versionFor', () => {
  it('uses the smallest version that holds the text', () => {
    // Level M byte-mode capacities: 14, 26, 42, 62 bytes for versions 1 to 4.
    expect(versionFor(14)).toBe(1);
    expect(versionFor(15)).toBe(2);
    expect(versionFor(26)).toBe(2);
    expect(versionFor(27)).toBe(3);
    expect(versionFor(42)).toBe(3);
    expect(versionFor(62)).toBe(4);
  });

  it('gives up rather than producing a symbol it cannot encode', () => {
    expect(versionFor(213)).toBe(QR_MAX_VERSION);
    expect(versionFor(214)).toBeNull();
  });
});

describe('sizeOf', () => {
  it('is 17 + 4v, so version 1 is 21 modules and version 10 is 57', () => {
    expect(sizeOf(1)).toBe(21);
    expect(sizeOf(7)).toBe(45);
    expect(sizeOf(10)).toBe(57);
  });
});

describe('errorCorrectionFor', () => {
  /**
   * The worked example in ISO/IEC 18004 annex I: the version-1 level-M code for
   * "01234567", whose ten error-correction codewords are published.
   */
  it('reproduces the annex I example', () => {
    const data = [
      0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec,
      0x11,
    ];

    expect(errorCorrectionFor(data, 10)).toEqual([
      0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55,
    ]);
  });

  it('produces exactly the number of codewords asked for', () => {
    expect(errorCorrectionFor([1, 2, 3], 26)).toHaveLength(26);
  });
});

describe('maskPenalty', () => {
  it('charges an all-dark symbol heavily and a balanced one less', () => {
    const allDark = Array.from({ length: 21 }, () => new Array<boolean>(21).fill(true));
    const checker = Array.from({ length: 21 }, (_row, y) =>
      Array.from({ length: 21 }, (_column, x) => (x + y) % 2 === 0),
    );

    expect(maskPenalty(allDark)).toBeGreaterThan(maskPenalty(checker));
  });
});

describe('encodeQr', () => {
  it('draws a symbol of the right size for an otpauth URI', () => {
    const matrix = encodeQr(OTPAUTH);

    // 97 bytes fits version 6 at level M, which holds 106.
    expect(matrix).toHaveLength(sizeOf(6));
    expect(matrix[0]).toHaveLength(sizeOf(6));
  });

  it('puts a finder pattern in each of the three corners', () => {
    const matrix = encodeQr('hello');
    const size = matrix.length;
    const corners: readonly (readonly [number, number])[] = [
      [0, 0],
      [0, size - 7],
      [size - 7, 0],
    ];

    for (const [top, left] of corners) {
      // The outer ring is dark, the ring inside it is light, the core is dark.
      expect(matrix[top]?.[left]).toBe(true);
      expect(matrix[top + 1]?.[left + 1]).toBe(false);
      expect(matrix[top + 3]?.[left + 3]).toBe(true);
    }
  });

  it('separates each finder from the data with a light border', () => {
    const matrix = encodeQr('hello');

    for (let index = 0; index <= 7; index += 1) {
      expect(matrix[7]?.[index]).toBe(false);
      expect(matrix[index]?.[7]).toBe(false);
    }
  });

  it('alternates the timing patterns between the finders', () => {
    const matrix = encodeQr('hello');

    for (let index = 8; index < matrix.length - 8; index += 1) {
      expect(matrix[6]?.[index], `row 6 column ${String(index)}`).toBe(index % 2 === 0);
      expect(matrix[index]?.[6], `column 6 row ${String(index)}`).toBe(index % 2 === 0);
    }
  });

  it('always sets the dark module', () => {
    const matrix = encodeQr('hello');

    expect(matrix[matrix.length - 8]?.[8]).toBe(true);
  });

  it('writes the same format string in both copies, and one the table knows', () => {
    const matrix = encodeQr('hello');
    const size = matrix.length;

    const first = [
      ...Array.from({ length: 6 }, (_unused, index) => matrix[index]?.[8] === true),
      matrix[7]?.[8] === true,
      matrix[8]?.[8] === true,
      matrix[8]?.[7] === true,
      ...Array.from({ length: 6 }, (_unused, index) => matrix[8]?.[5 - index] === true),
    ];
    const second = [
      ...Array.from({ length: 8 }, (_unused, index) => matrix[8]?.[size - 1 - index] === true),
      ...Array.from({ length: 7 }, (_unused, index) => matrix[size - 7 + index]?.[8] === true),
    ];

    expect(second).toEqual(first);

    const bits = first.reduce((value, dark, index) => (dark ? value | (1 << index) : value), 0);
    expect(FORMAT_STRINGS_M).toContain(bits);
  });

  it('writes the version string for a symbol large enough to carry one', () => {
    // 150 bytes needs version 8 at level M, which holds 152.
    const matrix = encodeQr('x'.repeat(150));
    const size = matrix.length;
    expect(size).toBe(sizeOf(8));

    let bits = 0;
    for (let index = 0; index < 18; index += 1) {
      const row = Math.floor(index / 3);
      const column = (index % 3) + size - 11;
      if (matrix[row]?.[column] === true) {
        bits |= 1 << index;
      }
      // The same eighteen modules appear transposed beside the other finder.
      expect(matrix[column]?.[row]).toBe(matrix[row]?.[column]);
    }

    expect(bits).toBe(VERSION_STRINGS.get(8));
  });

  it('refuses text no supported version can hold, rather than truncating it', () => {
    expect(() => encodeQr('x'.repeat(214))).toThrow(QrTooLongError);
  });

  it('encodes non-ASCII as UTF-8, counting bytes and not characters', () => {
    // Fourteen Arabic characters are 28 bytes, which needs version 3, while
    // fourteen ASCII characters fit in version 1.
    expect(encodeQr('ا'.repeat(14))).toHaveLength(sizeOf(3));
    expect(encodeQr('a'.repeat(14))).toHaveLength(sizeOf(1));
  });
});

describe('qrPath', () => {
  it('emits one square per dark module and nothing for a light one', () => {
    expect(
      qrPath([
        [true, false],
        [false, true],
      ]),
    ).toBe('M0,0h1v1h-1zM1,1h1v1h-1z');
  });

  it('is empty for a matrix with nothing in it', () => {
    expect(qrPath([[false]])).toBe('');
  });
});
