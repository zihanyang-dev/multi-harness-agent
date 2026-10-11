import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { closeDatabase, createDatabase } from './connection.js';

it('ends its owned pool even before the Kysely driver has initialized', async () => {
  const pool = new Pool({ host: '127.0.0.1', port: 1 });
  try {
    await closeDatabase(createDatabase(pool), pool);
    expect(pool.ended).toBe(true);
  } finally {
    if (!pool.ended) await pool.end();
  }
});

it('uses the PostgreSQL dialect and quotes schema identifiers', async () => {
  const pool = new Pool({
    host: '127.0.0.1',
    port: 1,
    user: 'test',
    password: 'test',
    database: 'test',
  });
  try {
    const database = createDatabase(pool);
    expect(database.schema.createSchema('test";drop table t').compile().sql).toBe(
      'create schema "test"";drop table t"',
    );
    await database.destroy();
  } finally {
    if (!pool.ended) await pool.end();
  }
});
