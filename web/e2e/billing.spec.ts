import { type Page, expect, test } from '@playwright/test';

/*
 * The main journey of a shop owner, start to finish:
 * register -> create shop -> add products -> opening stock -> customer ->
 * bill glass by size with payment -> invoice -> dashboard.
 * Screenshots go to E2E_SCREENSHOTS (if set) for visual review.
 */

const shots = process.env.E2E_SCREENSHOTS;
const snap = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
};
const phone = `9${Date.now().toString().slice(-9)}`;

test('owner sets up a shop and bills glass by size', async ({ page }) => {
  // Anything the Content-Security-Policy blocks shows up as a console error.
  const blocked: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) blocked.push(m.text());
  });

  // ---- register + shop ---------------------------------------------------------
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await snap(page, '01-login');
  await page.getByRole('link', { name: 'Create an account' }).click();
  await page.getByLabel('Your name').fill('Ravi Sharma');
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByLabel('Password').fill('a-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByText('Set up your shop')).toBeVisible();
  await page.getByLabel('Shop name').fill('Sharma Glass House');
  await page.getByLabel('State').selectOption('07');
  await page.getByLabel('GSTIN').fill('07ABCDE1234F1Z5');
  await snap(page, '02-create-shop');
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // ---- products ----------------------------------------------------------------
  await page.getByRole('link', { name: 'Products' }).click();
  await page.getByRole('button', { name: 'New product' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Clear Float Glass 5mm');
  await page.getByRole('dialog').getByLabel('SKU / code').fill('GL-CLR-5');
  await page.getByRole('dialog').getByLabel('Thickness (mm)').fill('5');
  await page.getByRole('dialog').getByLabel('Retail price (B2C)').fill('90');
  await page.getByRole('dialog').getByLabel('Wholesale price (B2B)').fill('75');
  await snap(page, '03-product-form');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Product added')).toBeVisible();

  await page.getByRole('button', { name: 'New product' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('SS Handle 8 inch');
  await page.getByRole('dialog').getByLabel('SKU / code').fill('HW-HDL-8');
  await page.getByRole('dialog').getByLabel('Kind').selectOption('hardware');
  await page.getByRole('dialog').getByLabel('Retail price (B2C)').fill('300');
  await page.getByRole('dialog').getByLabel('Wholesale price (B2B)').fill('250');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: /SS Handle 8 inch/ })).toBeVisible();
  await snap(page, '04-products');

  // ---- opening stock -------------------------------------------------------------
  await page.getByRole('link', { name: 'Stock', exact: true }).click();
  for (const [product, qty] of [
    ['Clear Float', '500'],
    ['SS Handle', '100'],
  ] as const) {
    await page.getByRole('button', { name: 'Adjust stock' }).click();
    await page.getByRole('dialog').getByPlaceholder('Add product: type name or SKU…').fill(product);
    await page.getByRole('option').first().click();
    await page
      .getByRole('dialog')
      .getByLabel(/^Quantity/)
      .fill(qty);
    await page.getByRole('dialog').getByLabel('This is opening stock').check();
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(new RegExp(`${product}.*: now`))).toBeVisible();
  }
  await expect(page.getByRole('cell', { name: '500 SQFT' })).toBeVisible();
  await snap(page, '05-stock');

  // ---- B2B customer --------------------------------------------------------------
  await page.getByRole('link', { name: 'Customers & suppliers' }).click();
  await page.getByRole('button', { name: 'New party' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Delhi Fabricators');
  await page.getByRole('dialog').getByLabel('GSTIN').fill('07AAACB1234C1Z2');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'Delhi Fabricators' })).toBeVisible();

  // ---- the bill --------------------------------------------------------------------
  await page.getByRole('link', { name: 'New bill' }).click();
  await page.getByPlaceholder('Search customer by name, phone or GSTIN…').fill('Delhi');
  await page.getByRole('option', { name: /Delhi Fabricators/ }).click();
  await expect(page.getByText('B2B', { exact: true })).toBeVisible();

  const productSearch = page.getByPlaceholder('Add product: type name or SKU…');
  await productSearch.fill('glass');
  await productSearch.press('Enter');
  await page.getByLabel('Width').fill('36');
  await page.getByLabel('Height').fill('48');
  await page.getByLabel('Pcs').fill('2');
  await page.getByLabel('Discount ₹').press('Enter'); // back to product search
  await expect(productSearch).toBeFocused();
  await productSearch.fill('handle');
  await productSearch.press('Enter');
  await page.getByLabel(/^Qty/).fill('4');

  // 24 sq ft x 75 + 4 x 250 = 2800 + 18% = 3304
  await expect(page.getByText('= 24 SQFT')).toBeVisible();
  await expect(page.locator('dl').getByText('₹3,304.00')).toBeVisible();
  await snap(page, '06-new-bill');

  await page.getByLabel('Payment mode').selectOption('upi');
  await page.getByLabel('Amount received').fill('2000');
  await page.getByRole('button', { name: 'Save & post bill' }).click();

  // ---- the invoice -------------------------------------------------------------------
  await expect(page.getByRole('heading', { name: /MAIN\d{4}\/00001/ })).toBeVisible();
  await expect(page.getByText('Posted')).toBeVisible();
  await expect(page.getByText('₹1,304.00')).toBeVisible(); // balance due
  await expect(
    page.getByRole('cell', { name: 'Clear Float Glass 5mm (36 x 48 in x 2 pcs)' }),
  ).toBeVisible();
  await snap(page, '07-invoice');

  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByLabel('Amount (₹)')).toHaveValue('1304.00');
  await page.getByRole('button', { name: 'Save payment' }).click();
  await expect(page.locator('dd').getByText('Paid', { exact: true })).toBeVisible(); // the badge

  // ---- dashboard ---------------------------------------------------------------------
  await page.getByRole('link', { name: 'Dashboard' }).click();
  await expect(page.getByText('₹3,304.00').first()).toBeVisible();
  await snap(page, '08-dashboard');

  // ---- session security ----------------------------------------------------------------
  // The refresh token lives in an httpOnly cookie: page scripts can't read it...
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + document.cookie);
  expect(stored).not.toMatch(/refresh/i);
  // ...yet a reload keeps the user signed in.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  expect(blocked).toEqual([]);
});
