import type { Env } from '@helpdock/config';
import { MasterKeyRotationError, type RotationReport } from '@helpdock/db';
import { describe, expect, it, vi } from 'vitest';
import { type CliDeps, formatRotationReport, runCli } from './cli.js';

const report: RotationReport = {
  currentKeyId: 'bbbbbbbb',
  previousKeyId: 'aaaaaaaa',
  counts: [
    { place: 'users.totp_secret_encrypted', rotated: 2, current: 1 },
    { place: 'settings.value', rotated: 3, current: 0 },
  ],
  rotated: 5,
};

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) },
    out,
    err,
  };
};

const deps = (rotate: CliDeps['rotate']): CliDeps => ({ loadEnv: () => ({}) as Env, rotate });

describe('runCli', () => {
  it('rotates and prints a report for `keys rotate`', async () => {
    const { io, out } = capture();
    const rotate = vi.fn().mockResolvedValue(report);

    await expect(runCli(['keys', 'rotate'], io, deps(rotate))).resolves.toBe(0);

    expect(rotate).toHaveBeenCalledOnce();
    expect(out.join('')).toContain('5 value(s) re-encrypted');
  });

  it('prints the usage and exits 2 for anything else, without touching the database', async () => {
    const rotate = vi.fn();

    for (const argv of [[], ['keys'], ['keys', 'rotate', '--force'], ['rotate-master-key']]) {
      const { io, err } = capture();
      await expect(runCli(argv, io, deps(rotate))).resolves.toBe(2);
      expect(err.join('')).toContain('keys rotate');
    }
    expect(rotate).not.toHaveBeenCalled();
  });

  it('exits 1 with the reason when the rotation is refused', async () => {
    const { io, err } = capture();
    const rotate = vi.fn().mockRejectedValue(new MasterKeyRotationError(['webhooks.secret']));

    await expect(runCli(['keys', 'rotate'], io, deps(rotate))).resolves.toBe(1);

    expect(err.join('')).toContain('webhooks.secret');
  });
});

describe('formatRotationReport', () => {
  it('names each place with its counts and both key ids', () => {
    const text = formatRotationReport(report);

    expect(text).toContain('key aaaaaaaa -> key bbbbbbbb');
    expect(text).toMatch(/users\.totp_secret_encrypted\s+2 rotated\s+1 already current/);
    expect(text).toMatch(/settings\.value\s+3 rotated\s+0 already current/);
  });

  it('says when there was no previous key', () => {
    expect(formatRotationReport({ ...report, previousKeyId: null })).toContain('no previous key');
  });
});
