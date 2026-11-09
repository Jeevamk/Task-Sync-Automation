import { Logger } from '@nestjs/common';
import { waitUntil } from '@vercel/functions';

const logger = new Logger('Background');

/** Run work after the HTTP response has been sent (Vercel: waitUntil; locally the promise just runs). */
export function runInBackground(label: string, work: () => Promise<unknown>): void {
  const promise = work().catch((err: unknown) => {
    logger.error(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  try {
    waitUntil(promise);
  } catch {
    // Not on Vercel: nothing else to do.
  }
}