import { Kysely, PostgresDialect } from 'kysely';
import type { Pool } from 'pg';

import type { DatabaseSchema } from './schema.js';

export type Database = Kysely<DatabaseSchema>;

/** Constructs native SQL access. The process owns the pool and waits for its consumers. */
export function createDatabase(pool: Pool): Database {
  return new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
}

/** Closes SQL access and its owned pool, including pools used only by another native consumer. */
export async function closeDatabase(database: Database, pool: Pool): Promise<void> {
  try {
    await database.destroy();
  } finally {
    if (!pool.ended) await pool.end();
  }
}
