import { AppError, notFound, versionConflict } from '../http/errors.js';
import type { DbClient } from './transaction.js';

/** Runs a query and returns its rows. */
export async function query<Row extends object>(
  client: DbClient,
  sql: string,
  params: unknown[] = [],
): Promise<Row[]> {
  const result = await client.query(sql, params);
  return result.rows as Row[];
}

/** Runs a query and returns the first row, or undefined. */
export async function queryOne<Row extends object>(
  client: DbClient,
  sql: string,
  params: unknown[] = [],
): Promise<Row | undefined> {
  return (await query<Row>(client, sql, params))[0];
}

/**
 * Builds the SET clause of a partial update from an API object.
 * Only keys present in `input` (and listed in `columns`) are updated.
 *
 *   buildSet({ name: 'name', retailPrice: 'retail_price' }, { name: 'X' }, 3)
 *   -> { sql: 'name = $3', values: ['X'] }
 */
export function buildSet(
  columns: Record<string, string>,
  input: Record<string, unknown>,
  firstParam: number,
): { sql: string; values: unknown[] } {
  const parts: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (input[key] !== undefined) {
      values.push(input[key]);
      parts.push(`${column} = $${firstParam + values.length - 1}`);
    }
  }
  return { sql: parts.join(', '), values };
}

/**
 * Optimistic-locking update: succeeds only if the row still has the version the
 * client last read. Otherwise someone else saved first -> 409, the client
 * reloads and re-applies its change. (Nobody silently overwrites anybody.)
 *
 * `table` is always a constant from our code, never user input.
 */
export async function updateVersioned<Row extends object>(
  client: DbClient,
  table: string,
  entity: string,
  id: string,
  version: number,
  columns: Record<string, string>,
  input: Record<string, unknown>,
): Promise<Row> {
  const set = buildSet(columns, input, 3);
  if (!set.sql) throw new AppError(400, 'VALIDATION_FAILED', 'Nothing to update');

  const row = await queryOne<Row>(
    client,
    `UPDATE ${table} SET ${set.sql} WHERE id = $1 AND version = $2 RETURNING *`,
    [id, version, ...set.values],
  );
  if (row) return row;
  const exists = await queryOne(client, `SELECT 1 FROM ${table} WHERE id = $1`, [id]);
  throw exists ? versionConflict() : notFound(entity);
}

/**
 * INSERT from an object keyed by column name. `table` and the keys always come
 * from our code, never from user input; values are parameters.
 */
export async function insertRow<Row extends object>(
  client: DbClient,
  table: string,
  row: Record<string, unknown>,
): Promise<Row> {
  const columns = Object.keys(row);
  const inserted = await queryOne<Row>(
    client,
    `INSERT INTO ${table} (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING *`,
    Object.values(row),
  );
  return inserted!;
}

/** Inserts a document's lines, numbering them 1..n. */
export async function insertLines(
  client: DbClient,
  table: string,
  parentColumn: string,
  parentId: string,
  lines: object[],
): Promise<void> {
  for (const [i, line] of lines.entries()) {
    await insertRow(client, table, { [parentColumn]: parentId, line_no: i + 1, ...line });
  }
}

/** Escapes LIKE wildcards in user input: "50%" matches literally. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}
