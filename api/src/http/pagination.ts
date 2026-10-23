import { z } from 'zod';
import { AppError } from './errors.js';

/*
 * List endpoints use page tokens (Google API style):
 *   GET /v1/products?pageSize=50
 *   -> { items: [...], nextPageToken: "eyJvIjo1MH0" }
 *   GET /v1/products?pageSize=50&pageToken=eyJvIjo1MH0
 * The token is opaque to clients, so the paging strategy can change later
 * (e.g. to keyset paging) without breaking them.
 */

export const PageQuery = z.object({
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  pageToken: z.string().optional(),
});

export interface Page {
  limit: number;
  offset: number;
}

export function readPage(query: z.infer<typeof PageQuery>): Page {
  if (!query.pageToken) return { limit: query.pageSize, offset: 0 };
  try {
    const { o } = JSON.parse(Buffer.from(query.pageToken, 'base64url').toString('utf8')) as {
      o: unknown;
    };
    if (!Number.isInteger(o) || (o as number) < 0) throw new Error('bad offset');
    return { limit: query.pageSize, offset: o as number };
  } catch {
    throw new AppError(400, 'VALIDATION_FAILED', 'Invalid pageToken');
  }
}

/**
 * Query with LIMIT page.limit + 1; the extra row tells us there is a next page.
 */
export function toPage<T>(rows: T[], page: Page): { items: T[]; nextPageToken: string | null } {
  const hasMore = rows.length > page.limit;
  const items = hasMore ? rows.slice(0, page.limit) : rows;
  const nextPageToken = hasMore
    ? Buffer.from(JSON.stringify({ o: page.offset + page.limit })).toString('base64url')
    : null;
  return { items, nextPageToken };
}
