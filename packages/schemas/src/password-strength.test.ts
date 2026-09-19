import { describe, expect, it } from 'vitest';
import {
  estimatePasswordStrength,
  isPasswordAcceptable,
  PASSWORD_STRENGTHS,
} from './password-strength.js';

describe('estimatePasswordStrength', () => {
  it.each([
    ['', 'weak'],
    ['short', 'weak'],
    ['elevenchars', 'weak'],
    // Twelve characters, but a name everyone tries first.
    ['password1234', 'weak'],
    ['Password-123!', 'weak'],
    ['ChangeMe123!', 'weak'],
    ['aaaaaaaaaaaa', 'weak'],
    ['abababababab', 'weak'],
    ['xxqwertyuiopxx', 'weak'],
    ['xx0987654321xx', 'weak'],
  ])('calls %j weak', (password, expected) => {
    expect(estimatePasswordStrength(password).strength).toBe(expected);
  });

  it.each([
    // Long enough, one character class: nothing wrong with it, nothing notable.
    ['twelveletter', 'fair'],
    ['twelveletter7', 'fair'],
    // Three classes, or sixteen characters: either one is a step up.
    ['Twelveletter7', 'good'],
    ['sixteencharacters', 'good'],
    // Sixteen characters and three classes, or simply long.
    ['Sixteencharacter7', 'strong'],
    ['a very long passphrase indeed', 'strong'],
  ])('calls %j %s', (password, expected) => {
    expect(estimatePasswordStrength(password).strength).toBe(expected);
  });

  it('scores each strength at its own step, so a meter has four of them', () => {
    const readings = ['password1234', 'twelveletter', 'Twelveletter7', 'Sixteencharacter7'].map(
      (password) => estimatePasswordStrength(password),
    );

    expect(readings.map((reading) => reading.score)).toEqual([0, 1, 2, 3]);
    expect(readings.map((reading) => reading.strength)).toEqual([...PASSWORD_STRENGTHS]);
  });

  it('never scores outside the meter it feeds', () => {
    for (const password of ['', 'x', 'twelveletter', 'A'.repeat(64)]) {
      const { score } = estimatePasswordStrength(password);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThan(PASSWORD_STRENGTHS.length);
    }
  });
});

describe('isPasswordAcceptable', () => {
  it('refuses exactly what the meter draws as weak, and nothing else', () => {
    expect(isPasswordAcceptable('password1234')).toBe(false);
    expect(isPasswordAcceptable('twelveletter')).toBe(true);
  });
});
