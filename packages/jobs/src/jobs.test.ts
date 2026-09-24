import { describe, expect, it } from 'vitest';
import {
  assignmentOfflineUnassignJob,
  idempotencyKeyFor,
  JOB_DEFINITIONS,
  maintenanceRetentionJob,
  mediaProcessJob,
  OUTBOX_RELAY_INTERVAL_MS,
  outboxEventJob,
  outboxRelayJob,
  parseJobPayload,
  RETENTION_DAYS,
} from './jobs.js';
import { QUEUE_NAME_LIST } from './queues.js';
import { PayloadValidationError } from './validation.js';

const outboxId = '01924f00-0000-7000-8000-000000000001';
const brandId = '01924f00-0000-7000-8000-0000000000aa';

const validEvent = {
  outboxId,
  brandId,
  event: 'settings.changed',
  payload: { key: 'smtp.host' },
};

describe('the job registry', () => {
  it('keys every definition by its own name', () => {
    for (const [name, definition] of Object.entries(JOB_DEFINITIONS)) {
      expect(definition.name).toBe(name);
    }
  });

  it('runs every job on a queue from ARCHITECTURE §13', () => {
    for (const definition of Object.values(JOB_DEFINITIONS)) {
      expect(QUEUE_NAME_LIST).toContain(definition.queue);
    }
  });

  it('freezes a definition, so nothing can retune a job at runtime', () => {
    expect(Object.isFrozen(outboxEventJob)).toBe(true);
  });

  it('gives the relay the poll cadence ARCHITECTURE §13 fixes', () => {
    expect(outboxRelayJob.schedule).toEqual({ everyMs: OUTBOX_RELAY_INTERVAL_MS });
  });

  it('runs retention nightly', () => {
    expect(maintenanceRetentionJob.schedule).toEqual({ cron: '0 3 * * *' });
  });
});

describe('outbox.event payloads', () => {
  it('accepts a published row', () => {
    expect(parseJobPayload(outboxEventJob, validEvent)).toEqual(validEvent);
  });

  it('refuses an event name that is not dotted lower case', () => {
    expect(() =>
      parseJobPayload(outboxEventJob, { ...validEvent, event: 'SettingsChanged' }),
    ).toThrow(PayloadValidationError);
  });

  it('refuses ids that are not uuids', () => {
    expect(() => parseJobPayload(outboxEventJob, { ...validEvent, brandId: 'brand-a' })).toThrow(
      PayloadValidationError,
    );
  });

  it('names the job and the field in the failure, which is what reaches the DLQ', () => {
    try {
      parseJobPayload(outboxEventJob, { ...validEvent, outboxId: 'not-a-uuid' });
    } catch (error) {
      expect((error as Error).message).toContain('payload for job outbox.event');
      expect((error as PayloadValidationError).issues[0]?.path).toBe('outboxId');
    }
  });
});

describe('maintenance.retention payloads', () => {
  it('defaults to the seven days of DOMAIN-RULES §11', () => {
    expect(parseJobPayload(maintenanceRetentionJob, { brandId })).toEqual({
      brandId,
      olderThanDays: RETENTION_DAYS,
    });
  });

  it('refuses a retention window of less than a day', () => {
    expect(() => parseJobPayload(maintenanceRetentionJob, { brandId, olderThanDays: 0 })).toThrow(
      PayloadValidationError,
    );
  });
});

describe('idempotencyKeyFor', () => {
  it('uses the natural key when the definition has one', () => {
    expect(idempotencyKeyFor(outboxEventJob, validEvent, 'some-other-job-id')).toBe(
      `outbox.event:${outboxId}`,
    );
  });

  it('is stable across deliveries of the same outbox row', () => {
    expect(idempotencyKeyFor(outboxEventJob, validEvent, 'first')).toBe(
      idempotencyKeyFor(outboxEventJob, validEvent, 'second'),
    );
  });

  it('falls back to the job name and id when the definition has no natural key', () => {
    expect(
      idempotencyKeyFor(maintenanceRetentionJob, { brandId, olderThanDays: 7 }, 'job-42'),
    ).toBe('maintenance.retention:job-42');
  });

  it('keys media.process by the attachment, so a requeued upload is processed once', () => {
    const attachmentId = '01924f00-0000-7000-8000-0000000000bb';

    expect(idempotencyKeyFor(mediaProcessJob, { brandId, attachmentId }, 'first')).toBe(
      `media.process:${attachmentId}`,
    );
    expect(idempotencyKeyFor(mediaProcessJob, { brandId, attachmentId }, 'first')).toBe(
      idempotencyKeyFor(mediaProcessJob, { brandId, attachmentId }, 'second'),
    );
  });
});

describe('media.process payloads', () => {
  it('accepts the brand and the attachment', () => {
    const payload = { brandId, attachmentId: '01924f00-0000-7000-8000-0000000000bb' };

    expect(parseJobPayload(mediaProcessJob, payload)).toEqual(payload);
  });

  it('refuses a payload with no attachment to process', () => {
    expect(() => parseJobPayload(mediaProcessJob, { brandId })).toThrow(PayloadValidationError);
  });

  it('runs on the media queue of ARCHITECTURE §13', () => {
    expect(mediaProcessJob.queue).toBe('media');
  });
});

describe('assignment.offline_unassign', () => {
  const payload = {
    brandId,
    userId: '01924f00-0000-7000-8000-0000000000a1',
    departmentId: '01924f00-0000-7000-8000-0000000000d1',
    since: '2026-09-24T10:00:00.000Z',
  };

  it('accepts one departure from one department', () => {
    expect(parseJobPayload(assignmentOfflineUnassignJob, payload)).toEqual(payload);
  });

  it('refuses a departure with no time, since the timer counts from it', () => {
    expect(() =>
      parseJobPayload(assignmentOfflineUnassignJob, { ...payload, since: 'yesterday' }),
    ).toThrow(PayloadValidationError);
  });

  it('keys each departure separately, so coming back and leaving again starts a new timer', () => {
    const later = { ...payload, since: '2026-09-24T10:30:00.000Z' };

    expect(idempotencyKeyFor(assignmentOfflineUnassignJob, payload, 'first')).toBe(
      idempotencyKeyFor(assignmentOfflineUnassignJob, payload, 'second'),
    );
    expect(idempotencyKeyFor(assignmentOfflineUnassignJob, payload, 'first')).not.toBe(
      idempotencyKeyFor(assignmentOfflineUnassignJob, later, 'first'),
    );
  });

  it('runs on a queue of its own', () => {
    expect(assignmentOfflineUnassignJob.queue).toBe('assignment');
  });
});
