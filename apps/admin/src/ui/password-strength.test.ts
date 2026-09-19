import { describe, expect, it } from 'vitest';
import { PASSWORD_STRENGTH_LEVELS, passwordStrength } from './password-strength.js';

describe('passwordStrength', () => {
  it('says nothing about an empty field', () => {
    expect(passwordStrength('')).toEqual({ score: 0, level: 'weak' });
  });

  /**
   * The bar must never be encouraging about a password the api is about to
   * refuse: twelve characters is the floor, and below it nothing else counts.
   */
  it('keeps anything under the twelve-character floor at weak', () => {
    expect(passwordStrength('Aa1!Aa1!Aa1').level).toBe('weak');
    expect(passwordStrength('short').level).toBe('weak');
  });

  it('rewards length more than variety', () => {
    const long = passwordStrength('correct horse battery staple');
    const short = passwordStrength('Aa1!Aa1!Aa1!');

    expect(long.score).toBeGreaterThan(short.score);
  });

  it('climbs with length', () => {
    const twelve = passwordStrength(`${'a'.repeat(3)}bcdf ghjk l`);
    const twenty = passwordStrength('the quick brown fox jumps');

    expect(twenty.score).toBeGreaterThan(twelve.score);
  });

  it('gives a long mixed phrase the top level', () => {
    expect(passwordStrength('Correct Horse 7 Battery Staple!').level).toBe('strong');
  });

  it('marks down a run of repeated characters', () => {
    const repeated = passwordStrength('aaaaaaaaaaaaaaaa');
    const varied = passwordStrength('abqzmfktrwdvhgnp');

    expect(repeated.score).toBeLessThan(varied.score);
  });

  it('marks down a keyboard run', () => {
    expect(passwordStrength('abcdefghijklmnop').score).toBeLessThan(
      passwordStrength('abqzmfktrwdvhgnp').score,
    );
  });

  it('marks down a password that is only digits', () => {
    expect(passwordStrength('918273645509182').score).toBeLessThan(
      passwordStrength('abqzmfktrwdvhgnp').score,
    );
  });

  it('never leaves the four levels the bar draws', () => {
    const samples = ['', 'a', 'a'.repeat(12), 'Correct Horse 7 Battery Staple!', 'أ'.repeat(30)];

    for (const sample of samples) {
      const { score, level } = passwordStrength(sample);

      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(3);
      expect(PASSWORD_STRENGTH_LEVELS).toContain(level);
    }
  });

  it('ignores surrounding whitespace when judging length', () => {
    expect(passwordStrength('   short   ').level).toBe('weak');
  });
});
