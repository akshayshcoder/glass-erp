import { type Page, expect, test } from '@playwright/test';

/*
 * The rest of the shop's work, start to finish:
 * purchase -> pay supplier -> quotation -> bill -> receive payment ->
 * customer return (credit note) -> add a team member -> lock a GST month.
 */

const shots = process.env.E2E_SCREENSHOTS;
const snap = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
};
const uniquePhone = () => `8${Date.now().toString().slice(-9)}`;
const dialog = (page: Page) => page.getByRole('dialog');

async function setUpShop(page: Page) {
  await page.goto('/register');
  await page.getByLabel('Your name').fill('Sunil Gupta');
  await page.getByLabel('Mobile number').fill(uniquePhone());
  await page.getByLabel('Password').fill('a-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Shop name').fill('Gupta Glass & Aluminium');
  await page.getByLabel('State').selectOption('07');
  await page.getByLabel('GSTIN').fill('07ABCDE1234F1Z5');
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

async function addProduct(
  page: Page,
  p: { name: string; sku: string; kind?: string; retail: string; wholesale: string },
) {
  await page.getByRole('link', { name: 'Products' }).click();
  await page.getByRole('button', { name: 'New product' }).click();
  await dialog(page).getByLabel('Name').fill(p.name);
  await dialog(page).getByLabel('SKU / code').fill(p.sku);
  if (p.kind) await dialog(page).getByLabel('Kind').selectOption(p.kind);
  await dialog(page).getByLabel('Retail price (B2C)').fill(p.retail);
  await dialog(page).getByLabel('Wholesale price (B2B)').fill(p.wholesale);
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: new RegExp(p.name) })).toBeVisible();
}

async function addParty(page: Page, name: string, gstin: string, kind: 'customer' | 'supplier') {
  await page.getByRole('link', { name: 'Customers & suppliers' }).click();
  await page.getByRole('button', { name: 'New party' }).click();
  await dialog(page).getByLabel('Name').fill(name);
  await dialog(page).getByLabel('Type').selectOption(kind);
  await dialog(page).getByLabel('GSTIN').fill(gstin);
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name })).toBeVisible();
}

async function addLine(page: Page, search: string) {
  const box = page.getByPlaceholder('Add product: type name or SKU…');
  await box.fill(search);
  await box.press('Enter');
}

test('purchases, quotations, receipts, returns, team and GST lock', async ({ page }) => {
  await setUpShop(page);
  await addProduct(page, {
    name: 'Clear Float Glass 5mm',
    sku: 'GL-5',
    retail: '90',
    wholesale: '75',
  });
  await addProduct(page, {
    name: 'SS Handle 8 inch',
    sku: 'HW-8',
    kind: 'hardware',
    retail: '300',
    wholesale: '250',
  });
  await addParty(page, 'Gujarat Glass Works', '24AAACG1234K1Z9', 'supplier');
  await addParty(page, 'Delhi Fabricators', '07AAACB1234C1Z2', 'customer');

  // ---- purchase: 500 sq ft of glass + 50 handles from another state (IGST) ----
  await page.getByRole('link', { name: 'Purchase bills' }).click();
  await page.getByRole('button', { name: 'New purchase' }).click();
  await page.getByPlaceholder('Search supplier by name, phone or GSTIN…').fill('Gujarat');
  await page.getByRole('option', { name: /Gujarat Glass Works/ }).click();
  await page.getByLabel("Supplier's bill no.").fill('GJ/9001');
  await addLine(page, 'glass');
  await page.getByLabel(/^Qty \(SQFT\)/).fill('500'); // purchases default to quantity, not size
  await page.getByLabel(/^Rate \/ SQFT/).fill('40');
  await addLine(page, 'handle');
  await page.getByLabel(/^Qty \(PCS\)/).fill('50');
  await page.getByLabel(/^Rate \/ PCS/).fill('150');
  // 20000 + 7500 = 27500 + 18% IGST 4950 = 32450
  await expect(page.locator('dl').getByText('IGST')).toBeVisible();
  await expect(page.locator('dl').getByText('₹32,450.00')).toBeVisible();
  await snap(page, '10-purchase-form');
  await page.getByRole('button', { name: 'Save & add to stock' }).click();
  await expect(page.getByRole('heading', { name: /MAINP\d{4}\/00001/ })).toBeVisible();

  await page.getByRole('button', { name: 'Pay supplier' }).click();
  await expect(dialog(page).getByLabel('Amount (₹)')).toHaveValue('32450.00');
  await dialog(page).getByRole('button', { name: 'Save payment' }).click();
  await expect(page.getByText('Payment saved')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pay supplier' })).toHaveCount(0);
  await snap(page, '11-purchase-paid');

  // ---- quotation -> bill ---------------------------------------------------------
  await page.getByRole('link', { name: 'Quotations' }).click();
  await page.getByRole('button', { name: 'New quotation' }).click();
  await page.getByPlaceholder('Search customer by name, phone or GSTIN…').fill('Delhi');
  await page.getByRole('option', { name: /Delhi Fabricators/ }).click();
  await addLine(page, 'glass');
  await page.getByLabel('Width').fill('48');
  await page.getByLabel('Height').fill('60');
  await addLine(page, 'handle');
  await page.getByLabel(/^Qty \(PCS\)/).fill('2');
  await page.getByLabel('Terms').fill('Fitting extra. 50% advance.');
  // 20 sq ft x 75 + 2 x 250 = 2000 + 18% = 2360
  await expect(page.locator('dl').getByText('₹2,360.00')).toBeVisible();
  await page.getByRole('button', { name: 'Save quotation' }).click();
  await page.getByRole('button', { name: 'Issue' }).click();
  await expect(page.getByRole('heading', { name: /MAINQ\d{4}\/00001/ })).toBeVisible();
  await page.getByRole('button', { name: 'Accepted' }).click();
  await snap(page, '12-quotation');
  await page.getByRole('button', { name: 'Convert to bill' }).click();
  await expect(page.getByRole('heading', { name: /Draft bill/ })).toBeVisible();
  await page.getByRole('button', { name: 'Post bill' }).click();
  await expect(page.getByRole('heading', { name: /MAIN\d{4}\/00001/ })).toBeVisible();

  // ---- receive payment for it ------------------------------------------------------
  await page.getByRole('link', { name: 'Receipts' }).click();
  await page.getByRole('button', { name: 'Receive payment' }).click();
  await dialog(page).getByPlaceholder('Search customer by name, phone or GSTIN…').fill('Delhi');
  await page.getByRole('option', { name: /Delhi Fabricators/ }).click();
  await dialog(page).getByLabel('Amount (₹)').fill('2360');
  await dialog(page).getByLabel('Mode').selectOption('upi');
  await dialog(page).getByRole('button', { name: 'Apply to oldest first' }).click();
  await expect(dialog(page).getByText('Applied ₹2,360.00')).toBeVisible();
  await snap(page, '13-receive-payment');
  await dialog(page).getByRole('button', { name: 'Save receipt' }).click();
  await expect(page.getByRole('cell', { name: /MAINR\d{4}\/00001/ })).toBeVisible();

  // ---- return 1 handle: credit note -----------------------------------------------------
  await page.getByRole('link', { name: 'Invoices', exact: true }).click();
  await page.getByRole('cell', { name: /MAIN\d{4}\/00001/ }).click();
  await expect(page.locator('dd').getByText('Paid', { exact: true })).toBeVisible(); // the badge
  await page.getByRole('button', { name: 'Return / credit note' }).click();
  await page.getByLabel('Qty returned for SS Handle 8 inch').fill('1');
  await expect(page.locator('dl').getByText('₹295.00')).toBeVisible(); // 250 + 18%
  await snap(page, '14-credit-note');
  await page.getByRole('button', { name: 'Save credit note' }).click();
  await expect(page.getByRole('heading', { name: /MAINCN\d{4}\/00001/ })).toBeVisible();

  await page.getByRole('link', { name: 'Stock', exact: true }).click();
  await expect(page.getByRole('cell', { name: '49 PCS' })).toBeVisible(); // 50 bought - 2 sold + 1 back
  await expect(page.getByRole('cell', { name: '480 SQFT' })).toBeVisible(); // 500 - 20

  // ---- add a team member ---------------------------------------------------------------
  const cashierPhone = uniquePhone();
  const reg = await page.request.post('/v1/auth/register', {
    data: { fullName: 'Pooja (cashier)', phone: cashierPhone, password: 'another-long-password' },
  });
  expect(reg.status()).toBe(201);
  await page.getByRole('link', { name: 'Team' }).click();
  await page.getByRole('button', { name: 'Add person' }).click();
  await dialog(page).getByLabel('Their phone or email').fill(cashierPhone);
  await dialog(page).getByLabel('Role').selectOption('billing');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'Pooja (cashier)' })).toBeVisible();
  await snap(page, '15-team');

  // ---- GST month lock -----------------------------------------------------------------
  await page.getByRole('link', { name: 'GST month lock' }).click();
  await page.getByLabel('Note').fill('GSTR-1 filed');
  await page.getByRole('button', { name: /^Lock / }).click();
  await expect(page.getByRole('cell', { name: 'GSTR-1 filed' })).toBeVisible();
  await snap(page, '16-gst-lock');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await dialog(page).getByLabel('Reason').fill('test');
  await dialog(page).getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByText('No months locked yet')).toBeVisible();

  // ---- reports ------------------------------------------------------------------------
  const thisMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })
    .format(new Date())
    .slice(0, 7);
  await page.getByRole('link', { name: 'GSTR-1' }).click();
  await page.getByLabel('Return period').fill(thisMonth);
  // B2B bill 2,000 taxable; the return of 1 handle (250) is a registered credit note.
  await expect(page.getByRole('row', { name: /B2B: registered customers/ })).toContainText(
    '2,000.00',
  );
  await expect(page.getByRole('row', { name: /Credit notes: registered/ })).toContainText('250.00');
  await snap(page, '17-gstr1');
  const excel = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Excel' }).click();
  expect((await excel).suggestedFilename()).toMatch(/^GSTR1_07ABCDE1234F1Z5_\d{6}\.xlsx$/);
  const json = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON for GST portal' }).click();
  expect((await json).suggestedFilename()).toMatch(/\.json$/);

  await page.getByRole('link', { name: 'Stock value' }).click();
  // 480 sq ft x Rs 40 last purchase price
  await expect(page.getByRole('row', { name: /Clear Float Glass 5mm/ })).toContainText('19,200.00');

  await page.getByRole('link', { name: 'Dues' }).click();
  await expect(page.getByText('Nothing outstanding')).toBeVisible(); // everyone is paid up
  await page.getByLabel('Show').selectOption('payables');
  await expect(page.getByText('Nothing outstanding')).toBeVisible();

  await page.getByRole('link', { name: 'Sales', exact: true }).click();
  await page.getByLabel('Group by').selectOption('product');
  await expect(page.getByRole('row', { name: /Clear Float Glass 5mm/ })).toContainText('1,500.00');
  await snap(page, '18-sales-report');
});
