/**
 * A QR encoder for one job: turning an `otpauth://` URI into a matrix the
 * enrolment screen draws as SVG.
 *
 * **Why not a package.** The one candidate, `qrcode`, brings `pngjs`, `yargs`
 * and `dijkstrajs` for a page that needs none of them, and adding a dependency
 * outside the stack table in ARCHITECTURE §1 needs an ADR. What is actually
 * needed is byte mode, one error-correction level, and the handful of versions
 * an `otpauth://` URI fits in — which is this file, and which is testable
 * against the tables in ISO/IEC 18004 rather than against a library's output.
 *
 * **What it supports, and why that is enough.** Byte mode, error correction
 * level M, versions 1 to 10. An `otpauth://totp/` URI with an address, a base32
 * secret and an issuer runs to about 120 characters; version 10 at level M
 * holds 213 bytes, so there is room to spare and a clear error when there is
 * not. Level M recovers about 15 % of the code, which is what every
 * authenticator app expects and what leaves the pattern coarse enough to scan
 * from a laptop screen.
 *
 * Everything below is the specification: the tables are its tables, the
 * polynomials are its polynomials, and the mask penalties are its four rules.
 */

/** Error correction level M: about 15 % of the symbol can be lost and read back. */
const EC_LEVEL_M_BITS = 0b00;

const MODE_BYTE = 0b0100;

export const QR_MAX_VERSION = 10;

interface VersionSpec {
  /** Error-correction codewords per block. */
  readonly ecPerBlock: number;
  /** `[blockCount, dataCodewordsPerBlock]` for the one or two block groups. */
  readonly groups: readonly (readonly [number, number])[];
  /** Centres of the alignment patterns, in both axes. */
  readonly alignment: readonly number[];
  /** Bits of padding after the last codeword (ISO/IEC 18004 table 1). */
  readonly remainderBits: number;
}

/** ISO/IEC 18004 tables 9 and E.1, for error-correction level M. */
const VERSIONS: readonly VersionSpec[] = [
  { ecPerBlock: 10, groups: [[1, 16]], alignment: [], remainderBits: 0 },
  { ecPerBlock: 16, groups: [[1, 28]], alignment: [6, 18], remainderBits: 7 },
  { ecPerBlock: 26, groups: [[1, 44]], alignment: [6, 22], remainderBits: 7 },
  { ecPerBlock: 18, groups: [[2, 32]], alignment: [6, 26], remainderBits: 7 },
  { ecPerBlock: 24, groups: [[2, 43]], alignment: [6, 30], remainderBits: 7 },
  { ecPerBlock: 16, groups: [[4, 27]], alignment: [6, 34], remainderBits: 7 },
  { ecPerBlock: 18, groups: [[4, 31]], alignment: [6, 22, 38], remainderBits: 0 },
  {
    ecPerBlock: 22,
    groups: [
      [2, 38],
      [2, 39],
    ],
    alignment: [6, 24, 42],
    remainderBits: 0,
  },
  {
    ecPerBlock: 22,
    groups: [
      [3, 36],
      [2, 37],
    ],
    alignment: [6, 26, 46],
    remainderBits: 0,
  },
  {
    ecPerBlock: 26,
    groups: [
      [4, 43],
      [1, 44],
    ],
    alignment: [6, 28, 50],
    remainderBits: 0,
  },
];

const specOf = (version: number): VersionSpec => {
  const spec = VERSIONS[version - 1];
  /* c8 ignore next 3 -- `versionFor` never returns a version outside the table. */
  if (spec === undefined) {
    throw new RangeError(`QR version ${String(version)} is not supported`);
  }

  return spec;
};

const dataCodewordsOf = (spec: VersionSpec): number =>
  spec.groups.reduce((total, [blocks, size]) => total + blocks * size, 0);

/** Versions 1 to 9 count the byte run in 8 bits; 10 and above in 16. */
const countBits = (version: number): number => (version < 10 ? 8 : 16);

export const sizeOf = (version: number): number => 17 + 4 * version;

/** The smallest version that holds `byteLength`, or `null` when none does. */
export const versionFor = (byteLength: number): number | null => {
  for (let version = 1; version <= QR_MAX_VERSION; version += 1) {
    const spec = specOf(version);
    const capacityBits = dataCodewordsOf(spec) * 8 - 4 - countBits(version);
    if (byteLength * 8 <= capacityBits) {
      return version;
    }
  }

  return null;
};

// --------------------------------------------------------------------------
// GF(256), as QR defines it: primitive polynomial x^8 + x^4 + x^3 + x^2 + 1.
// --------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    EXP[index] = value;
    LOG[value] = index;
    value <<= 1;
    if (value & 0x100) {
      value ^= 0x11d;
    }
  }
  for (let index = 255; index < 512; index += 1) {
    EXP[index] = EXP[index - 255] ?? 0;
  }
}

const multiply = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : (EXP[((LOG[a] ?? 0) + (LOG[b] ?? 0)) % 255] ?? 0);

/**
 * The generator polynomial for `degree` error-correction codewords: the product
 * of `(x - a^i)` for i below `degree`. Coefficients descend, leading term
 * first, which is the order the division below consumes them in.
 */
const generatorPolynomial = (degree: number): number[] => {
  let poly = [1];
  for (let index = 0; index < degree; index += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (const [position, coefficient] of poly.entries()) {
      next[position] = (next[position] ?? 0) ^ coefficient;
      next[position + 1] = (next[position + 1] ?? 0) ^ multiply(coefficient, EXP[index] ?? 0);
    }
    poly = next;
  }

  return poly;
};

/** Reed-Solomon remainder: the error-correction codewords for one block. */
export const errorCorrectionFor = (data: readonly number[], degree: number): number[] => {
  const generator = generatorPolynomial(degree);
  const remainder = new Array<number>(degree).fill(0);

  for (const byte of data) {
    const factor = byte ^ (remainder.shift() ?? 0);
    remainder.push(0);
    if (factor !== 0) {
      for (const [index, coefficient] of generator.slice(1).entries()) {
        remainder[index] = (remainder[index] ?? 0) ^ multiply(coefficient, factor);
      }
    }
  }

  return remainder;
};

// --------------------------------------------------------------------------
// BCH, for the format and version information
// --------------------------------------------------------------------------

const bch = (value: number, generator: number, generatorBits: number): number => {
  let remainder = value << (generatorBits - 1);
  for (let bit = 14; bit >= generatorBits - 1; bit -= 1) {
    if (remainder & (1 << bit)) {
      remainder ^= generator << (bit - (generatorBits - 1));
    }
  }

  return remainder;
};

/**
 * The 15 bits written twice around the top-left finder. The XOR keeps the
 * all-zero combination from producing an all-zero pattern, which a reader
 * could not tell from blank paper.
 */
export const formatInformation = (mask: number): number => {
  const data = (EC_LEVEL_M_BITS << 3) | mask;
  const remainder = bch(data, 0b10100110111, 11);

  return ((data << 10) | remainder) ^ 0b101010000010010;
};

/** The 18 bits versions 7 and above carry beside the other two finders. */
export const versionInformation = (version: number): number => {
  let remainder = version << 12;
  for (let bit = 17; bit >= 12; bit -= 1) {
    if (remainder & (1 << bit)) {
      remainder ^= 0b1111100100101 << (bit - 12);
    }
  }

  return (version << 12) | remainder;
};

// --------------------------------------------------------------------------
// The matrix
// --------------------------------------------------------------------------

/** `true` is a dark module. Row-major, `matrix[row][column]`. */
export type QrMatrix = readonly (readonly boolean[])[];

const FINDER = [
  [1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1],
];

interface Canvas {
  readonly modules: boolean[][];
  /** Function patterns, which the data stream skips and the mask leaves alone. */
  readonly reserved: boolean[][];
  readonly size: number;
}

const blankCanvas = (size: number): Canvas => ({
  modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  size,
});

const place = (canvas: Canvas, row: number, column: number, dark: boolean): void => {
  const line = canvas.modules[row];
  const marks = canvas.reserved[row];
  if (line === undefined || marks === undefined) {
    return;
  }

  line[column] = dark;
  marks[column] = true;
};

const drawFinders = (canvas: Canvas): void => {
  const corners = [
    [0, 0],
    [0, canvas.size - 7],
    [canvas.size - 7, 0],
  ] as const;

  for (const [top, left] of corners) {
    // The separator is the one-module light border around the finder, so it is
    // drawn as part of it rather than as an afterthought.
    for (let row = -1; row <= 7; row += 1) {
      for (let column = -1; column <= 7; column += 1) {
        const y = top + row;
        const x = left + column;
        if (y < 0 || y >= canvas.size || x < 0 || x >= canvas.size) {
          continue;
        }

        const inside = row >= 0 && row < 7 && column >= 0 && column < 7;
        place(canvas, y, x, inside && FINDER[row]?.[column] === 1);
      }
    }
  }
};

const drawTiming = (canvas: Canvas): void => {
  for (let index = 8; index < canvas.size - 8; index += 1) {
    const dark = index % 2 === 0;
    place(canvas, 6, index, dark);
    place(canvas, index, 6, dark);
  }
};

const drawAlignment = (canvas: Canvas, spec: VersionSpec): void => {
  for (const centreRow of spec.alignment) {
    for (const centreColumn of spec.alignment) {
      // The three corners already hold finders.
      const atFinder =
        (centreRow === 6 && centreColumn === 6) ||
        (centreRow === 6 && centreColumn === canvas.size - 7) ||
        (centreRow === canvas.size - 7 && centreColumn === 6);
      if (atFinder) {
        continue;
      }

      for (let row = -2; row <= 2; row += 1) {
        for (let column = -2; column <= 2; column += 1) {
          const ring = Math.max(Math.abs(row), Math.abs(column));
          place(canvas, centreRow + row, centreColumn + column, ring !== 1);
        }
      }
    }
  }
};

/**
 * Reserved before the data is placed; written once a mask has been chosen.
 *
 * Row 6 and column 6 are skipped: they carry the timing patterns, which run
 * straight through the format area and are *not* part of it. Blanking them here
 * is the one mistake that produces a symbol which looks right and scans as
 * nothing.
 */
const reserveFormatAreas = (canvas: Canvas): void => {
  for (let index = 0; index <= 8; index += 1) {
    if (index !== 6) {
      place(canvas, index, 8, false);
      place(canvas, 8, index, false);
    }
  }

  for (let index = 0; index < 8; index += 1) {
    place(canvas, 8, canvas.size - 1 - index, false);
    place(canvas, canvas.size - 1 - index, 8, false);
  }

  // The one module that is always dark (ISO/IEC 18004 §8.9).
  place(canvas, canvas.size - 8, 8, true);
};

const drawVersionInformation = (canvas: Canvas, version: number): void => {
  if (version < 7) {
    return;
  }

  const bits = versionInformation(version);
  for (let index = 0; index < 18; index += 1) {
    const dark = ((bits >> index) & 1) === 1;
    const row = Math.floor(index / 3);
    const column = (index % 3) + canvas.size - 11;

    place(canvas, row, column, dark);
    place(canvas, column, row, dark);
  }
};

/**
 * The two copies of ISO/IEC 18004 §8.9, written after the mask is chosen
 * because the mask number is part of what they encode. The placement is
 * awkward on purpose: it is what the specification lays out, module by module,
 * around the top-left finder and split between the other two.
 */
const writeFormatInformation = (canvas: Canvas, mask: number): void => {
  const bits = formatInformation(mask);
  const at = (index: number): boolean => ((bits >> index) & 1) === 1;

  // First copy: down column 8, then left along row 8.
  for (let index = 0; index <= 5; index += 1) {
    place(canvas, index, 8, at(index));
  }
  place(canvas, 7, 8, at(6));
  place(canvas, 8, 8, at(7));
  place(canvas, 8, 7, at(8));
  for (let index = 9; index <= 14; index += 1) {
    place(canvas, 8, 14 - index, at(index));
  }

  // Second copy: along row 8 from the right edge, then up column 8.
  for (let index = 0; index <= 7; index += 1) {
    place(canvas, 8, canvas.size - 1 - index, at(index));
  }
  for (let index = 8; index <= 14; index += 1) {
    place(canvas, canvas.size - 15 + index, 8, at(index));
  }

  place(canvas, canvas.size - 8, 8, true);
};

const MASKS: readonly ((row: number, column: number) => boolean)[] = [
  (row, column) => (row + column) % 2 === 0,
  (row) => row % 2 === 0,
  (_row, column) => column % 3 === 0,
  (row, column) => (row + column) % 3 === 0,
  (row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
  (row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
  (row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
  (row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0,
];

/** The zigzag of ISO/IEC 18004 §8.7.3: two columns at a time, right to left. */
const placeData = (canvas: Canvas, bits: readonly boolean[]): void => {
  let index = 0;
  let upward = true;

  for (let right = canvas.size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern and is never half of a pair, so
    // the walk steps over it and carries on with the odd columns below it.
    if (right === 6) {
      right = 5;
    }

    for (let step = 0; step < canvas.size; step += 1) {
      const row = upward ? canvas.size - 1 - step : step;

      for (const column of [right, right - 1]) {
        if (canvas.reserved[row]?.[column] === true) {
          continue;
        }

        const line = canvas.modules[row];
        if (line !== undefined) {
          line[column] = bits[index] ?? false;
        }
        index += 1;
      }
    }

    upward = !upward;
  }
};

// --------------------------------------------------------------------------
// Mask penalties (ISO/IEC 18004 §8.8.2)
// --------------------------------------------------------------------------

const runPenalty = (run: number): number => (run >= 5 ? run - 2 : 0);

const linePenalty = (line: readonly boolean[]): number => {
  let penalty = 0;
  let run = 1;

  for (let index = 1; index < line.length; index += 1) {
    if (line[index] === line[index - 1]) {
      run += 1;
    } else {
      penalty += runPenalty(run);
      run = 1;
    }
  }

  return penalty + runPenalty(run);
};

const FINDER_RUN = [true, false, true, true, true, false, true];

const hasFinderRun = (line: readonly boolean[], start: number): boolean =>
  FINDER_RUN.every((dark, offset) => line[start + offset] === dark);

const linePatternPenalty = (line: readonly boolean[]): number => {
  let penalty = 0;

  for (let index = 0; index + 7 <= line.length; index += 1) {
    if (!hasFinderRun(line, index)) {
      continue;
    }

    const before = line.slice(Math.max(0, index - 4), index);
    const after = line.slice(index + 7, index + 11);
    const quietBefore = before.length === 4 && before.every((dark) => !dark);
    const quietAfter = after.length === 4 && after.every((dark) => !dark);

    if (quietBefore || quietAfter) {
      penalty += 40;
    }
  }

  return penalty;
};

const columnsOf = (modules: readonly (readonly boolean[])[]): boolean[][] =>
  modules.map((_row, column) => modules.map((row) => row[column] ?? false));

export const maskPenalty = (modules: readonly (readonly boolean[])[]): number => {
  const size = modules.length;
  const columns = columnsOf(modules);

  // Rule 1: runs of five or more of one shade, in rows and columns.
  let penalty = 0;
  for (const line of [...modules, ...columns]) {
    penalty += linePenalty(line);
  }

  // Rule 2: every 2x2 block of one shade.
  for (let row = 0; row + 1 < size; row += 1) {
    for (let column = 0; column + 1 < size; column += 1) {
      const first = modules[row]?.[column];
      if (
        first === modules[row]?.[column + 1] &&
        first === modules[row + 1]?.[column] &&
        first === modules[row + 1]?.[column + 1]
      ) {
        penalty += 3;
      }
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 run with four light modules beside it.
  for (const line of [...modules, ...columns]) {
    penalty += linePatternPenalty(line);
  }

  // Rule 4: how far the proportion of dark modules is from a half.
  const dark = modules.flat().filter(Boolean).length;
  const percent = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return penalty;
};

// --------------------------------------------------------------------------

/** Thrown when the text is longer than version 10 at level M can hold. */
export class QrTooLongError extends Error {
  constructor(byteLength: number) {
    super(`${String(byteLength)} bytes is more than a version-10 QR code holds`);
    this.name = 'QrTooLongError';
  }
}

const toCodewords = (bytes: Uint8Array, version: number, spec: VersionSpec): number[] => {
  const bits: boolean[] = [];
  const push = (value: number, width: number): void => {
    for (let bit = width - 1; bit >= 0; bit -= 1) {
      bits.push(((value >> bit) & 1) === 1);
    }
  };

  push(MODE_BYTE, 4);
  push(bytes.length, countBits(version));
  for (const byte of bytes) {
    push(byte, 8);
  }

  const capacity = dataCodewordsOf(spec) * 8;
  // The terminator is up to four zero bits, then zeroes to the byte boundary.
  for (let index = 0; index < 4 && bits.length < capacity; index += 1) {
    bits.push(false);
  }
  while (bits.length % 8 !== 0) {
    bits.push(false);
  }

  const codewords: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      byte = (byte << 1) | (bits[index + bit] === true ? 1 : 0);
    }
    codewords.push(byte);
  }

  // The two pad codewords of ISO/IEC 18004 §8.4.9, alternating and always
  // starting with 0xEC however many codewords the data itself came to.
  let pad = 0xec;
  while (codewords.length < dataCodewordsOf(spec)) {
    codewords.push(pad);
    pad = pad === 0xec ? 0x11 : 0xec;
  }

  return codewords;
};

/** Split into blocks, correct each, then interleave both halves (§8.6). */
const interleave = (codewords: readonly number[], spec: VersionSpec): boolean[] => {
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;

  for (const [count, size] of spec.groups) {
    for (let block = 0; block < count; block += 1) {
      const data = codewords.slice(offset, offset + size);
      offset += size;
      dataBlocks.push(data);
      ecBlocks.push(errorCorrectionFor(data, spec.ecPerBlock));
    }
  }

  const stream: number[] = [];
  const longest = Math.max(...dataBlocks.map((block) => block.length));
  for (let index = 0; index < longest; index += 1) {
    for (const block of dataBlocks) {
      const byte = block[index];
      if (byte !== undefined) {
        stream.push(byte);
      }
    }
  }
  for (let index = 0; index < spec.ecPerBlock; index += 1) {
    for (const block of ecBlocks) {
      stream.push(block[index] ?? 0);
    }
  }

  const bits: boolean[] = [];
  for (const byte of stream) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      bits.push(((byte >> bit) & 1) === 1);
    }
  }
  for (let index = 0; index < spec.remainderBits; index += 1) {
    bits.push(false);
  }

  return bits;
};

/**
 * The matrix for `text`, at the smallest version that holds it.
 *
 * The mask is chosen the way the specification says to choose it: all eight are
 * applied and the one with the lowest penalty wins. Picking a fixed mask would
 * usually work and would occasionally produce a code a phone cannot lock onto.
 */
export const encodeQr = (text: string): QrMatrix => {
  const bytes = new TextEncoder().encode(text);
  const version = versionFor(bytes.length);
  if (version === null) {
    throw new QrTooLongError(bytes.length);
  }

  const spec = specOf(version);
  const bits = interleave(toCodewords(bytes, version, spec), spec);

  let best: { modules: boolean[][]; penalty: number } | null = null;

  for (const [mask, shouldFlip] of MASKS.entries()) {
    const canvas = blankCanvas(sizeOf(version));
    drawFinders(canvas);
    drawTiming(canvas);
    drawAlignment(canvas, spec);
    reserveFormatAreas(canvas);
    drawVersionInformation(canvas, version);
    placeData(canvas, bits);

    for (let row = 0; row < canvas.size; row += 1) {
      for (let column = 0; column < canvas.size; column += 1) {
        if (canvas.reserved[row]?.[column] === true) {
          continue;
        }

        const line = canvas.modules[row];
        if (line !== undefined && shouldFlip(row, column)) {
          line[column] = !line[column];
        }
      }
    }

    writeFormatInformation(canvas, mask);

    const penalty = maskPenalty(canvas.modules);
    if (best === null || penalty < best.penalty) {
      best = { modules: canvas.modules, penalty };
    }
  }

  /* c8 ignore next 3 -- the loop above always runs eight times. */
  if (best === null) {
    throw new Error('no mask was evaluated');
  }

  return best.modules;
};

/**
 * The matrix as one SVG path, plus the quiet zone the specification requires.
 * One path rather than a rect per module keeps a 57×57 code to a single element
 * the browser draws in one go.
 */
export const qrPath = (matrix: QrMatrix): string => {
  const parts: string[] = [];

  for (const [row, line] of matrix.entries()) {
    for (const [column, dark] of line.entries()) {
      if (dark) {
        parts.push(`M${String(column)},${String(row)}h1v1h-1z`);
      }
    }
  }

  return parts.join('');
};

/** Four light modules on every side; less than that and readers struggle. */
export const QR_QUIET_ZONE = 4;
