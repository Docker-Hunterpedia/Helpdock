import { describe, expect, it } from 'vitest';
import type { Principal } from '../auth/principal.js';
import { activityActorFor } from './ticket-activity.js';

const ID = '01937f5e-7e53-7000-8000-000000000001';
const BRAND = '01937f5e-7e53-7000-8000-00000000000a';

describe('activityActorFor', () => {
  it('records a staff member as acting through the interface', () => {
    const principal: Principal = { type: 'staff', id: ID, brands: {}, installAdmin: false };

    expect(activityActorFor(principal)).toEqual({
      actorType: 'staff',
      actorId: ID,
      via: 'ui',
    });
  });

  it('records an api key as `api`, which is how the same person differs from the admin', () => {
    const principal: Principal = { type: 'apikey', id: ID, brandId: BRAND, scopes: [] };

    expect(activityActorFor(principal)).toEqual({ actorType: 'apikey', actorId: ID, via: 'api' });
  });

  it('records a visitor as themselves, not as the contact they may become', () => {
    const principal: Principal = {
      type: 'visitor',
      id: ID,
      brandId: BRAND,
      conversationIds: [],
    };

    expect(activityActorFor(principal)).toEqual({ actorType: 'visitor', actorId: ID, via: 'ui' });
  });

  it('names the job a worker ran as, so a change leads back to the job that made it', () => {
    const principal: Principal = { type: 'system', brandId: BRAND, jobId: 'outbox.event:42' };

    expect(activityActorFor(principal)).toEqual({
      actorType: 'system',
      actorId: 'outbox.event:42',
      via: 'system',
    });
  });
});
