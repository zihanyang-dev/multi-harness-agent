import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { closeDatabase, createDatabase } from '@multi-harness/database';
import { Pool } from 'pg';

/** Uses a unique schema and explicit loopback test URL; never loads the developer's .env. */
export async function createTestDatabase() {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined) throw new Error('TEST_DATABASE_URL is required for integration checks');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
    throw new Error('Integration checks require a loopback PostgreSQL server');
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  const adminDatabase = createDatabase(admin);
  await adminDatabase.schema.createSchema(schema).execute();
  const pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=3000`,
    max: 8,
  });
  const dispose = async () => {
    try {
      if (!pool.ended) await pool.end();
      await adminDatabase.schema.dropSchema(schema).cascade().execute();
    } finally {
      await closeDatabase(adminDatabase, admin);
    }
  };
  try {
    const directory = fileURLToPath(
      new URL('../../packages/database/migrations/', import.meta.url),
    );
    for (const file of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
      const migration = await readFile(`${directory}/${file}`, 'utf8');
      const up = migration.split('-- migrate:up')[1]?.split('-- migrate:down')[0];
      if (up === undefined) throw new Error('Missing migration up section');
      await pool.query(up);
    }
    await pool.query(`insert into "user" (id, name, email, "emailVerified") values
      ('alice', 'Alice', 'alice@example.invalid', false),
      ('bob', 'Bob', 'bob@example.invalid', false)`);
    return { database: createDatabase(pool), pool, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
