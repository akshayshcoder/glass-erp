import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app-context.js';
import { Permissions } from '../../auth/roles.js';
import { containsPattern, query, queryOne, updateVersioned } from '../../db/sql.js';
import { AppError, notFound } from '../../http/errors.js';
import { PageQuery, readPage, toPage } from '../../http/pagination.js';
import {
  Email,
  Gstin,
  IdParams,
  IsoDate,
  Money,
  NonEmpty,
  Phone,
  Pincode,
  PositiveMoney,
  SignedMoney,
  StateCode,
  Version,
} from '../../http/validation.js';

/**
 * Parties = customers and suppliers (one party can be both).
 *
 *   GET   /v1/parties?search=&kind=&status=&pageSize=&pageToken=   (includes current balance)
 *   GET   /v1/parties/:id
 *   POST  /v1/parties
 *   PATCH /v1/parties/:id
 *   GET   /v1/parties/:id/ledger?from=&to=        statement with running balance
 *   POST  /v1/parties/:id/opening-balance          once, when moving from paper books
 *
 * Balance sign: positive = they owe us, negative = we owe them.
 */

const Kind = z.enum(['customer', 'supplier', 'both']);

const PartyFields = {
  kind: Kind,
  name: NonEmpty,
  contactPerson: z.string().trim().nullable().optional(),
  phone: Phone.nullable().optional(),
  email: Email.nullable().optional(),
  gstin: Gstin.nullable().optional(),
  stateCode: StateCode.nullable().optional(),
  billingAddress: z.string().trim().nullable().optional(),
  shippingAddress: z.string().trim().nullable().optional(),
  pincode: Pincode.nullable().optional(),
  creditLimit: Money.optional(),
  creditDays: z.number().int().min(0).optional(),
};

/** With a GSTIN, the state is the GSTIN's first two digits; fill it in if missing. */
function withStateFromGstin<T extends { gstin?: string | null; stateCode?: string | null }>(
  b: T,
  ctx: z.RefinementCtx,
) {
  if (b.gstin) {
    const fromGstin = b.gstin.slice(0, 2);
    if (b.stateCode && b.stateCode !== fromGstin) {
      ctx.addIssue({
        code: 'custom',
        message: 'GSTIN must start with the state code',
        path: ['gstin'],
      });
    }
    return { ...b, stateCode: fromGstin };
  }
  return b;
}

const CreatePartyBody = z.object(PartyFields).transform(withStateFromGstin);
const UpdatePartyBody = z
  .object({ version: Version, isActive: z.boolean().optional(), ...PartyFields })
  .partial({ kind: true, name: true })
  .transform(withStateFromGstin);

const ListPartiesQuery = PageQuery.extend({
  search: z.string().trim().optional(),
  kind: z.enum(['customer', 'supplier']).optional(),
  status: z.enum(['active', 'inactive', 'all']).default('active'),
});

const LedgerQuery = z.object({ from: IsoDate.optional(), to: IsoDate.optional() });
const OpeningBalanceBody = z.object({
  /** Positive: they owe us. Negative: we owe them. */
  amount: SignedMoney.refine((v) => Number(v) !== 0, 'Cannot be zero'),
  asOf: IsoDate,
});

const COLUMNS = {
  kind: 'kind',
  name: 'name',
  contactPerson: 'contact_person',
  phone: 'phone',
  email: 'email',
  gstin: 'gstin',
  stateCode: 'state_code',
  billingAddress: 'billing_address',
  shippingAddress: 'shipping_address',
  pincode: 'pincode',
  creditLimit: 'credit_limit',
  creditDays: 'credit_days',
  isActive: 'is_active',
};

interface PartyRow {
  id: string;
  kind: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  state_code: string | null;
  billing_address: string | null;
  shipping_address: string | null;
  pincode: string | null;
  credit_limit: string;
  credit_days: number;
  is_active: boolean;
  version: number;
  balance?: string;
  wallet_balance?: string;
  total_outstanding?: string;
  available_credit?: string | null;
  unpaid_invoices_count?: number;
}

const toParty = (r: PartyRow) => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  contactPerson: r.contact_person,
  phone: r.phone,
  email: r.email,
  gstin: r.gstin,
  stateCode: r.state_code,
  billingAddress: r.billing_address,
  shippingAddress: r.shipping_address,
  pincode: r.pincode,
  creditLimit: r.credit_limit,
  creditDays: r.credit_days,
  isActive: r.is_active,
  version: r.version,
  ...(r.balance !== undefined && { balance: r.balance }),
  ...(r.wallet_balance !== undefined && { walletBalance: r.wallet_balance }),
  ...(r.total_outstanding !== undefined && { totalOutstanding: r.total_outstanding }),
  ...(r.available_credit !== undefined && { availableCredit: r.available_credit }),
  ...(r.unpaid_invoices_count !== undefined && { unpaidInvoicesCount: Number(r.unpaid_invoices_count) }),
});

const PARTY_WITH_BALANCE = `
  SELECT p.*,
         coalesce(b.balance, 0)::numeric(14,2)::text AS balance,
         coalesce(w.wallet_balance, 0)::numeric(14,2)::text AS wallet_balance,
         coalesce(ce.total_outstanding, 0)::numeric(14,2)::text AS total_outstanding,
         ce.available_credit::numeric(14,2)::text AS available_credit,
         coalesce(ce.unpaid_invoices_count, 0) AS unpaid_invoices_count
  FROM erp.parties p
  LEFT JOIN erp.v_party_balances b ON b.party_id = p.id
  LEFT JOIN erp.v_customer_wallet w ON w.party_id = p.id
  LEFT JOIN erp.v_customer_exposure ce ON ce.party_id = p.id`;

export function registerPartyRoutes(app: FastifyInstance, { guards }: AppContext) {
  app.get('/parties', { preHandler: guards.tenant(Permissions.read) }, async (request) => {
    const q = ListPartiesQuery.parse(request.query);
    const page = readPage(q);
    const rows = await request.tx((c) =>
      query<PartyRow>(
        c,
        `${PARTY_WITH_BALANCE}
         WHERE ($1::text IS NULL OR p.name ILIKE $1 OR p.phone ILIKE $1 OR p.gstin ILIKE $1)
           AND ($2::text IS NULL OR p.kind = $2 OR p.kind = 'both')
           AND ($3 = 'all' OR p.is_active = ($3 = 'active'))
         ORDER BY lower(p.name), p.id
         LIMIT $4 OFFSET $5`,
        [
          q.search ? containsPattern(q.search) : null,
          q.kind ?? null,
          q.status,
          page.limit + 1,
          page.offset,
        ],
      ),
    );
    const result = toPage(rows, page);
    return { items: result.items.map(toParty), nextPageToken: result.nextPageToken };
  });

  app.get('/parties/:id', { preHandler: guards.tenant(Permissions.read) }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const row = await request.tx((c) =>
      queryOne<PartyRow>(c, `${PARTY_WITH_BALANCE} WHERE p.id = $1`, [id]),
    );
    if (!row) throw notFound('Party');
    return toParty(row);
  });

  app.post(
    '/parties',
    { preHandler: guards.tenant(Permissions.manageParties) },
    async (request, reply) => {
      const p = CreatePartyBody.parse(request.body);
      const row = await request.tx(async (c) => {
        try {
          return await queryOne<PartyRow>(
            c,
            `INSERT INTO erp.parties
             (kind, name, contact_person, phone, email, gstin, state_code, billing_address, shipping_address,
              pincode, credit_limit, credit_days)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
            [
              p.kind,
              p.name,
              p.contactPerson ?? null,
              p.phone ?? null,
              p.email ?? null,
              p.gstin ?? null,
              p.stateCode ?? null,
              p.billingAddress ?? null,
              p.shippingAddress ?? null,
              p.pincode ?? null,
              p.creditLimit ?? '0',
              p.creditDays ?? 0,
            ],
          );
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            throw new AppError(409, 'DUPLICATE', 'A party with this GSTIN already exists');
          }
          throw err;
        }
      });
      return reply.status(201).send(toParty({ ...row!, balance: '0.00' }));
    },
  );

  app.patch(
    '/parties/:id',
    { preHandler: guards.tenant(Permissions.manageParties) },
    async (request) => {
      const { id } = IdParams.parse(request.params);
      const { version, ...changes } = UpdatePartyBody.parse(request.body);
      const row = await request.tx((c) =>
        updateVersioned<PartyRow>(c, 'erp.parties', 'Party', id, version, COLUMNS, changes),
      );
      return toParty(row);
    },
  );

  app.get(
    '/parties/:id/ledger',
    { preHandler: guards.tenant(Permissions.read) },
    async (request) => {
      const { id } = IdParams.parse(request.params);
      const { from, to } = LedgerQuery.parse(request.query);
      return request.tx(async (c) => {
        const party = await queryOne(c, 'SELECT 1 FROM erp.parties WHERE id = $1', [id]);
        if (!party) throw notFound('Party');
        const { opening } = (await queryOne<{ opening: string }>(
          c,
          `SELECT coalesce(sum(debit - credit), 0)::numeric(14,2)::text AS opening
         FROM erp.party_ledger WHERE party_id = $1 AND $2::date IS NOT NULL AND entry_date < $2::date`,
          [id, from ?? null],
        ))!;
        const entries = await query<{
          id: string;
          entry_date: string;
          entry_type: string;
          ref_id: string | null;
          ref_no: string | null;
          debit: string;
          credit: string;
          narration: string | null;
          balance: string;
        }>(
          c,
          `SELECT id, entry_date, entry_type, ref_id, ref_no, debit, credit, narration,
                ($3::numeric + sum(debit - credit) OVER (ORDER BY entry_date, id))::numeric(14,2)::text AS balance
         FROM erp.party_ledger
         WHERE party_id = $1
           AND ($2::date IS NULL OR entry_date >= $2::date)
           AND ($4::date IS NULL OR entry_date <= $4::date)
         ORDER BY entry_date, id`,
          [id, from ?? null, opening, to ?? null],
        );
        return {
          openingBalance: opening,
          closingBalance: entries.at(-1)?.balance ?? opening,
          entries: entries.map((e) => ({
            id: e.id,
            date: e.entry_date,
            type: e.entry_type,
            refId: e.ref_id,
            refNo: e.ref_no,
            debit: e.debit,
            credit: e.credit,
            narration: e.narration,
            balance: e.balance,
          })),
        };
      });
    },
  );

  app.post(
    '/parties/:id/opening-balance',
    { preHandler: guards.tenant(Permissions.postOpeningBalance) },
    async (request, reply) => {
      const { id } = IdParams.parse(request.params);
      const { amount, asOf } = OpeningBalanceBody.parse(request.body);
      await request.tx(async (c) => {
        try {
          await c.query('SELECT erp.post_opening_balance($1, $2, $3)', [id, amount, asOf]);
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            throw new AppError(409, 'DUPLICATE', 'This party already has an opening balance');
          }
          throw err;
        }
      });
      return reply.status(204).send();
    },
  );

  app.get('/parties/:id/wallet', { preHandler: guards.tenant(Permissions.read) }, async (request) => {
    const { id } = IdParams.parse(request.params);
    return request.tx(async (c) => {
      const party = await queryOne<{ id: string; name: string }>(
        c,
        'SELECT id, name FROM erp.parties WHERE id = $1',
        [id],
      );
      if (!party) throw notFound('Party');

      const wallet = await queryOne<{ wallet_balance: string; unallocated_receipts_count: string }>(
        c,
        'SELECT wallet_balance, unallocated_receipts_count FROM erp.v_customer_wallet WHERE party_id = $1',
        [id],
      );

      const receipts = await query<{
        receipt_id: string;
        receipt_no: string;
        receipt_date: string;
        mode: string;
        amount: string;
        total_allocated: string;
        unallocated_amount: string;
      }>(
        c,
        `SELECT receipt_id, receipt_no, receipt_date, mode, amount, total_allocated, unallocated_amount
         FROM erp.v_receipt_advance
         WHERE party_id = $1 AND unallocated_amount > 0
         ORDER BY receipt_date ASC, receipt_no ASC`,
        [id],
      );

      const unpaidInvoices = await query<{
        invoice_id: string;
        invoice_no: string;
        invoice_date: string;
        grand_total: string;
        amount_paid: string;
        amount_credited: string;
        balance_due: string;
        days_overdue: number;
      }>(
        c,
        `SELECT invoice_id, invoice_no, invoice_date, grand_total, amount_paid, amount_credited, balance_due, days_overdue
         FROM erp.v_invoice_outstanding
         WHERE party_id = $1 AND balance_due > 0
         ORDER BY invoice_date ASC, invoice_no ASC`,
        [id],
      );

      return {
        partyId: party.id,
        partyName: party.name,
        walletBalance: wallet?.wallet_balance ?? '0.00',
        unallocatedReceiptsCount: Number(wallet?.unallocated_receipts_count ?? 0),
        receipts: receipts.map((r) => ({
          receiptId: r.receipt_id,
          receiptNo: r.receipt_no,
          receiptDate: r.receipt_date,
          mode: r.mode,
          amount: r.amount,
          totalAllocated: r.total_allocated,
          unallocatedAmount: r.unallocated_amount,
        })),
        unpaidInvoices: unpaidInvoices.map((i) => ({
          invoiceId: i.invoice_id,
          invoiceNo: i.invoice_no,
          invoiceDate: i.invoice_date,
          grandTotal: i.grand_total,
          amountPaid: i.amount_paid,
          amountCredited: i.amount_credited,
          balanceDue: i.balance_due,
          daysOverdue: Number(i.days_overdue),
        })),
      };
    });
  });

  app.post(
    '/parties/:id/auto-knockoff',
    { preHandler: guards.tenant(Permissions.sell) },
    async (request) => {
      const { id } = IdParams.parse(request.params);
      const body = z.object({ maxAmount: PositiveMoney.optional() }).parse(request.body ?? {});
      return request.tx(async (c) => {
        const row = await queryOne<{ settle_customer_fifo: { partyId: string; totalSettled: number; invoicesCount: number } }>(
          c,
          'SELECT erp.settle_customer_fifo($1, $2)',
          [id, body.maxAmount ?? null],
        );
        return row?.settle_customer_fifo ?? { partyId: id, totalSettled: 0, invoicesCount: 0 };
      });
    },
  );
}
