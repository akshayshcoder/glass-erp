# Glass ERP Web

The browser app: React 19 + TypeScript + Vite, Tailwind CSS, TanStack Query, React Router.

## Run

The API must be running (see [../api/README.md](../api/README.md)). Then:

```bash
npm run dev            # http://localhost:5173 (forwards /v1 to the API on :4000)
```

Point it at another API with `API_URL=http://host:port npm run dev`.

Always start it with `npm run dev` from this folder, not `npx vite`: Vite is installed at the repository root
(workspaces), and `npx` may then start it from the wrong folder, which serves a blank page.

Production build: `npm run build` → static files in `dist/`. Serve them and route `/v1` to the API from the
**same origin** (e.g. nginx `location /v1 { proxy_pass ... }`), so no CORS setup is needed.

## Structure

```
src/
├── main.tsx              providers: React Query, auth, toasts, router
├── index.css             Tailwind + brand colours (change the theme here)
├── api/
│   ├── client.ts         the ONLY place that calls fetch: tokens, refresh, shop header, errors
│   └── types.ts          API response shapes
├── app/
│   ├── auth.tsx          signed-in user, selected shop, permissions (useCan)
│   ├── shop-data.tsx     branches + current branch, reference data (units, states)
│   ├── app-layout.tsx    sidebar, top bar, route guards
│   └── router.tsx        every screen and its URL
├── components/ui/        Button, Input, Select, Modal, Table, Badge, Toast… (use these, don't restyle)
├── lib/                  format.ts (₹, dates), money.ts (exact paise maths), pdf.ts, small hooks
└── features/             one folder per area
    ├── documents/        SHARED by all documents: line editor (sizes, live preview), pickers,
    │                     totals/lines views, payment allocation, action helpers
    ├── auth/             login, register, shop selection / creation
    ├── dashboard/
    ├── invoices/         billing screen, invoice list + detail
    ├── quotations/       list, form (new/edit draft), detail (issue → accept → convert)
    ├── receipts/         receive payment (apply to unpaid bills), cancel
    ├── credit-notes/     return / correction against an invoice, list, detail
    ├── purchases/        supplier bills (stock in), supplier payments
    ├── products/
    ├── parties/          customers & suppliers, ledger statement
    ├── stock/
    ├── reports/          GSTR-1 (Excel + portal JSON), sales, dues, stock value, purchase register;
    │                     one generic ReportTable renders any report the API describes
    └── settings/         team & roles, branches, GST month lock
```

## Rules of the road

- **No tax maths in the browser.** Totals and GST always come from the API's `/preview` endpoints while
  typing. Values are decimal strings; `lib/format.ts` displays them. The only arithmetic allowed is exact
  integer-paise maths in `lib/money.ts` (e.g. splitting a payment across bills); never `Number` maths on money.
- **New document type?** Reuse `features/documents/` (`LineItems`, `useDocumentPreview`, `LinesCard`,
  `TotalsRows`, `useDocumentActions`) instead of copying a page.
- **Server state lives in React Query**, keyed by resource (`['invoices', filters]`). After a change,
  invalidate the keys it affects.
- **Every create that costs money sends an `Idempotency-Key`** (see the billing screen and payment dialog).
- **Hide what the user can't do** with `useCan('sell')` etc. The API enforces it anyway.
- Accessible by default: labelled inputs, native `<dialog>`, keyboard navigation in pickers.

## End-to-end tests

Two journeys drive the real app in Chromium:

- [e2e/billing.spec.ts](e2e/billing.spec.ts): register → shop → products → stock → customer → bill glass by
  size → payment → dashboard.
- [e2e/back-office.spec.ts](e2e/back-office.spec.ts): purchase → pay supplier → quotation → bill → receive
  payment → return (credit note) → add a team member → lock a GST month.

Both It needs the web app running against an API with an
**empty test database** (never production data):

```bash
npx playwright install chromium            # once
E2E_BASE_URL=http://localhost:5173 npm run e2e
# optional: E2E_SCREENSHOTS=/some/folder saves a screenshot of every step
```
