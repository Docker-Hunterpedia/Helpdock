import { describe, expect, it } from 'vitest';
import {
  assignmentOfflineUnassignJob,
  emailPollJob,
  emailPollSchedulerId,
  emailSendJob,
  idempotencyKeyFor,
  JOB_DEFINITIONS,
  maintenanceRetentionJob,
  maintenanceRetentionScheduleJob,
  mediaProcessJob,
  OUTBOX_RELAY_INTERVAL_MS,
  outboxEventJob,
  outboxRelayJob,
  parseJobPayload,
  RULES_TIME_BASED_CRON,
  retentionJobId,
  rulesEvaluateJob,
  rulesEvaluateJobId,
  rulesTimeBasedJob,
  rulesTimeBasedJobId,
  rulesTimeBasedScheduleJob,
  slaRebuildJob,
  slaTimerJob,
  slaTimerJobId,
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

  it('ticks retention nightly, and leaves the per-brand job to that tick', () => {
    expect(maintenanceRetentionScheduleJob.schedule).toEqual({ cron: '0 3 * * *' });
    expect(maintenanceRetentionJob.schedule).toBeUndefined();
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
  it('names a brand and the night it runs for', () => {
    expect(parseJobPayload(maintenanceRetentionJob, { brandId, runDate: '2026-09-24' })).toEqual({
      brandId,
      runDate: '2026-09-24',
    });
  });

  it('refuses a run date that is not a calendar date', () => {
    expect(() =>
      parseJobPayload(maintenanceRetentionJob, { brandId, runDate: '2026-09-24T03:00:00Z' }),
    ).toThrow(PayloadValidationError);
  });

  it('gives one brand one job id per night, so a double tick adds nothing', () => {
    const tonight = retentionJobId({ brandId, runDate: '2026-09-24' });

    expect(tonight).toBe(retentionJobId({ brandId, runDate: '2026-09-24' }));
    expect(tonight).not.toBe(retentionJobId({ brandId, runDate: '2026-09-25' }));
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
      idempotencyKeyFor(maintenanceRetentionJob, { brandId, runDate: '2026-09-24' }, 'job-42'),
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

describe('email.send', () => {
  const deliveryId = '01924f00-0000-7000-8000-0000000000cc';

  it('keys every delivery of a send by its row, so the same job twice sends once', () => {
    expect(idempotencyKeyFor(emailSendJob, { brandId, deliveryId }, 'first')).toBe(
      `email.send:${deliveryId}`,
    );
    expect(idempotencyKeyFor(emailSendJob, { brandId, deliveryId }, 'second')).toBe(
      `email.send:${deliveryId}`,
    );
  });

  it('runs on the outbound queue and keeps what fails for the dead-letter view', () => {
    expect(emailSendJob.queue).toBe('outbound');
    expect(emailSendJob.options.attempts).toBe(5);
    expect(emailSendJob.options.removeOnFail).toBe(false);
  });

  it('refuses a payload with no delivery', () => {
    expect(() => parseJobPayload(emailSendJob, { brandId })).toThrow(PayloadValidationError);
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

describe('email.poll (M2-02)', () => {
  const payload = { brandId, mailboxId: '01924f00-0000-7000-8000-0000000000e1' };

  it('accepts one mailbox of one brand and refuses one without a mailbox', () => {
    expect(parseJobPayload(emailPollJob, payload)).toEqual(payload);
    expect(() => parseJobPayload(emailPollJob, { brandId })).toThrow(PayloadValidationError);
  });

  it('runs once per tick on the inbound queue, with a scheduler id per mailbox', () => {
    expect(emailPollJob.queue).toBe('inbound');
    expect(emailPollJob.options.attempts).toBe(1);
    expect(emailPollSchedulerId(payload.mailboxId)).toBe(`email.poll.${payload.mailboxId}`);
    expect(emailPollSchedulerId(payload.mailboxId)).not.toContain(':');
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

describe('sla.timer', () => {
  const payload = {
    brandId,
    ticketId: '01924f00-0000-7000-8000-0000000000b1',
    clock: 'resolution',
    stepPercent: 75,
  } as const;

  it('keys one timer per ticket, clock and step, without a colon BullMQ would refuse', () => {
    expect(slaTimerJobId(payload)).toBe('sla.01924f00-0000-7000-8000-0000000000b1.resolution.75');
    expect(slaTimerJobId(payload)).not.toContain(':');
  });

  it('refuses a clock that does not exist', () => {
    expect(() => parseJobPayload(slaTimerJob, { ...payload, clock: 'lunch' })).toThrow(
      PayloadValidationError,
    );
  });

  it('runs beside its rebuild on the sla queue, which re-ticks hourly', () => {
    expect(slaTimerJob.queue).toBe('sla');
    expect(slaRebuildJob.queue).toBe('sla');
    expect(slaRebuildJob.schedule).toEqual({ everyMs: 3_600_000 });
    expect(parseJobPayload(slaRebuildJob, {})).toEqual({});
  });
});

describe('the rules jobs (M3-03, M3-04)', () => {
  const evaluation = {
    brandId,
    ticketId: outboxId,
    triggers: ['ticket_updated', 'assigned'],
    sourceOutboxId: outboxId,
    chain: [brandId],
  };

  it('keys an evaluation by the outbox row it came from, in the job id and the receipt', () => {
    const payload = parseJobPayload(rulesEvaluateJob, evaluation);

    expect(rulesEvaluateJobId(payload)).toBe(`rules.evaluate.${outboxId}`);
    expect(idempotencyKeyFor(rulesEvaluateJob, payload, 'job-1')).toBe(
      `rules.evaluate:${outboxId}`,
    );
  });

  it('refuses a chain longer than the depth guard allows, and a trigger that is not a word', () => {
    expect(() =>
      parseJobPayload(rulesEvaluateJob, {
        ...evaluation,
        chain: [brandId, brandId, brandId, brandId],
      }),
    ).toThrow(PayloadValidationError);
    expect(() =>
      parseJobPayload(rulesEvaluateJob, { ...evaluation, triggers: ['Ticket Created'] }),
    ).toThrow(PayloadValidationError);
  });

  it('ticks time-based rules every five minutes, one job per brand per tick', () => {
    expect(rulesTimeBasedScheduleJob.schedule).toEqual({ cron: RULES_TIME_BASED_CRON });
    expect(RULES_TIME_BASED_CRON).toBe('*/5 * * * *');

    const payload = parseJobPayload(rulesTimeBasedJob, {
      brandId,
      tick: '2026-09-27T12:05:00.000Z',
    });
    expect(rulesTimeBasedJobId(payload)).toBe(
      `rules.time_based.${brandId}.${Date.parse('2026-09-27T12:05:00.000Z')}`,
    );
    expect(rulesTimeBasedJobId(payload)).not.toContain(':');
  });
});
