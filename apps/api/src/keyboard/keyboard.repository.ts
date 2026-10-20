import { type DbTransaction, users } from '@helpdock/db';
import type { KeyboardPreferences } from '@helpdock/schemas';
import { eq } from 'drizzle-orm';

/** The person's own row in `users`, which is where the switch lives (M14-01). */
export class KeyboardRepository {
  async read(tx: DbTransaction, userId: string): Promise<KeyboardPreferences | undefined> {
    const [row] = await tx
      .select({ singleKeyShortcuts: users.singleKeyShortcuts })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row;
  }

  async save(tx: DbTransaction, userId: string, preferences: KeyboardPreferences): Promise<void> {
    await tx
      .update(users)
      .set({ singleKeyShortcuts: preferences.singleKeyShortcuts })
      .where(eq(users.id, userId));
  }
}
