import { isTransientDatabaseError } from "../standardRail/errors.js";

/**
 * Run a read-only database read again when Postgres could not complete it
 * this time (serialization failure or deadlock). While an older gateway image
 * starts during a switch, its schema statements share the database with this
 * image, and on 2026-10-04 Postgres chose a release-capability read as a
 * deadlock victim. Never use this for a write: only reads repeat unchanged.
 */
export async function retryTransientRead<T>(read: () => Promise<T>, {
  attempts = 3,
  pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
}: { attempts?: number; pause?: (ms: number) => Promise<void> } = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (!isTransientDatabaseError(error) || attempt >= attempts) throw error;
      await pause(100 * attempt);
    }
  }
}
