/**
 * snake_case row -> camelCase JSON, minus internal columns.
 *
 * Used for documents (invoices, bills, ...), which have many columns that map
 * 1:1 to the API. Masters keep explicit toX() mappers.
 */
const INTERNAL_COLUMNS = new Set(['tenant_id', 'idempotency_key']);

export function toApi<T extends object>(row: T, omit: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (INTERNAL_COLUMNS.has(key) || omit.includes(key)) continue;
    out[key.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase())] = value;
  }
  return out;
}
