import { Link, createBrowserRouter } from 'react-router';
import { LoginPage, RegisterPage } from '../features/auth/auth-pages';
import { ShopsPage } from '../features/auth/shops-page';
import { CreditNotePage, CreditNotesPage } from '../features/credit-notes/credit-notes-pages';
import { NewCreditNotePage } from '../features/credit-notes/new-credit-note-page';
import { DashboardPage } from '../features/dashboard/dashboard-page';
import { InvoicePage } from '../features/invoices/invoice-page';
import { InvoicesPage } from '../features/invoices/invoices-page';
import { NewInvoicePage } from '../features/invoices/new-invoice-page';
import { PartiesPage } from '../features/parties/parties-page';
import { PartyPage } from '../features/parties/party-page';
import { ProductsPage } from '../features/products/products-page';
import { PurchaseFormPage } from '../features/purchases/purchase-form-page';
import { PurchaseBillPage, PurchaseBillsPage } from '../features/purchases/purchases-pages';
import { SupplierPaymentsPage } from '../features/purchases/supplier-payments-page';
import { QuotationFormPage } from '../features/quotations/quotation-form-page';
import { QuotationPage, QuotationsPage } from '../features/quotations/quotations-pages';
import { ReceiptsPage } from '../features/receipts/receipts-page';
import { BranchesPage } from '../features/settings/branches-page';
import { GstPeriodsPage } from '../features/settings/gst-periods-page';
import { TeamPage } from '../features/settings/team-page';
import {
  DuesReportPage,
  GstReportPage,
  PurchaseRegisterPage,
  SalesReportPage,
  StockValueReportPage,
} from '../features/reports/reports-pages';
import { StockPage } from '../features/stock/stock-page';
import { RequireAuth, RequireShop } from './app-layout';

/*
 * Every screen of the app. Public pages, then pages that need a signed-in user,
 * then pages that also need a selected shop (they get the sidebar layout).
 */
export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/shops', element: <ShopsPage /> },
      {
        element: <RequireShop />,
        children: [
          { path: '/', element: <DashboardPage /> },
          // Sales
          { path: '/invoices', element: <InvoicesPage /> },
          { path: '/invoices/new', element: <NewInvoicePage /> },
          { path: '/invoices/:id', element: <InvoicePage /> },
          { path: '/quotations', element: <QuotationsPage /> },
          { path: '/quotations/new', element: <QuotationFormPage /> },
          { path: '/quotations/:id', element: <QuotationPage /> },
          { path: '/quotations/:id/edit', element: <QuotationFormPage /> },
          { path: '/receipts', element: <ReceiptsPage /> },
          { path: '/credit-notes', element: <CreditNotesPage /> },
          { path: '/credit-notes/new', element: <NewCreditNotePage /> },
          { path: '/credit-notes/:id', element: <CreditNotePage /> },
          // Purchases
          { path: '/purchases', element: <PurchaseBillsPage /> },
          { path: '/purchases/new', element: <PurchaseFormPage /> },
          { path: '/purchases/:id', element: <PurchaseBillPage /> },
          { path: '/purchases/:id/edit', element: <PurchaseFormPage /> },
          { path: '/supplier-payments', element: <SupplierPaymentsPage /> },
          // Inventory
          { path: '/products', element: <ProductsPage /> },
          { path: '/stock', element: <StockPage /> },
          { path: '/parties', element: <PartiesPage /> },
          { path: '/parties/:id', element: <PartyPage /> },
          // Reports
          { path: '/reports/gst', element: <GstReportPage /> },
          { path: '/reports/sales', element: <SalesReportPage /> },
          { path: '/reports/dues', element: <DuesReportPage /> },
          { path: '/reports/stock', element: <StockValueReportPage /> },
          { path: '/reports/purchases', element: <PurchaseRegisterPage /> },
          // Settings
          { path: '/settings/team', element: <TeamPage /> },
          { path: '/settings/branches', element: <BranchesPage /> },
          { path: '/settings/gst', element: <GstPeriodsPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <NotFound /> },
]);

function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2">
      <p className="text-lg font-semibold text-slate-900">Page not found</p>
      <Link to="/" className="text-sm text-brand-700 hover:underline">
        Go to the dashboard
      </Link>
    </div>
  );
}
