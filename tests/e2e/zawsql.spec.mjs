import { test, expect, request as playwrightRequest } from '@playwright/test';
import { PORT, TOKEN, DB } from './env.mjs';

const schema = 'ze_' + Date.now().toString(36);
const sessionName = 'E2E ' + schema;
let api, adminSid, page;
const pageErrors = [];

async function call(method, path, body) {
  const r = await api.fetch('/api' + path, { method, headers: { 'X-Token': TOKEN }, data: body });
  const j = await r.json();
  if (!j.ok) throw new Error(`${path}: ${j.error}`);
  return j.data;
}
const exec = (...statements) => call('POST', `/s/${adminSid}/exec`, { statements, database: schema });
const scalar = async sql => (await exec(sql)).resultSets[0].rows[0][0];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  api = await playwrightRequest.newContext({ baseURL: `http://127.0.0.1:${PORT}` });
  const admin = await call('POST', '/sessions', { name: 'E2E admin', host: DB.host, port: DB.port, user: DB.user, password: DB.password, savePassword: true });
  adminSid = (await call('POST', '/connect', { sessionId: admin.id })).sid;
  await call('POST', `/s/${adminSid}/exec`, { statements: [`CREATE DATABASE \`${schema}\``] });
  await exec(
    'CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL, status ENUM(\'active\',\'blocked\') NOT NULL DEFAULT \'active\')',
    "INSERT INTO customers VALUES (1, 'Alice', 'active'), (2, 'Bob', 'blocked'), (3, 'Carol', 'active')",
    'CREATE TABLE logs (msg VARCHAR(20))',
    "INSERT INTO logs VALUES ('a'), ('b')");

  page = await browser.newPage();
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()); });
  await page.goto(`/#token=${TOKEN}`);
});

test.afterAll(async () => {
  await call('POST', `/s/${adminSid}/exec`, { statements: [`DROP DATABASE IF EXISTS \`${schema}\``] }).catch(() => {});
  await page?.close();
  await api?.dispose();
});

const field = label => page.locator('.sm-form label.frow', { hasText: label }).locator('input, select').first();
const treeNode = name => page.locator('.tn', { has: page.locator('.tl', { hasText: new RegExp(`^${name}$`) }) });
// Buttons inside the top-most dialog, matched by exact name (toolbar titles would match substrings).
const btn = name => page.locator('.modal').last().getByRole('button', { name, exact: true });
// Main tabs by title: a string must match exactly ("Data" must not hit "Database: …"), a RegExp as given.
const tab = name => page.locator('#tabbar .tab', {
  has: page.locator('.tab-title', { hasText: typeof name === 'string' ? new RegExp(`^${name}$`) : name }),
});

test('connects through the session manager', async () => {
  await expect(page.locator('.modal-title', { hasText: 'Session manager' })).toBeVisible();
  await btn('New').click();
  await field('Session name:').fill(sessionName);
  await field('Hostname / IP:').fill(DB.host);
  await field('User:').fill(DB.user);
  await field('Password:').fill(DB.password);
  await field('Port:').fill(String(DB.port));
  await btn('Save').click();
  await btn('Open').click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(treeNode(schema)).toBeVisible();
  await expect(page.locator('#statusbar')).toContainText('Connected');
});

test('browses and edits table data in the grid', async () => {
  await treeNode(schema).dblclick();
  await treeNode('customers').click();
  await expect(tab('Data')).toHaveClass(/active/);
  const rows = page.locator('.data-view .gr');
  await expect(rows).toHaveCount(3);
  await expect(page.locator('.data-info')).toContainText(`${schema}.customers`);

  await rows.nth(1).locator('.gc').nth(2).dblclick(); // Bob's name (cell 0 is the row gutter)
  const editor = page.locator('.data-view .grid-ed');
  await editor.fill('Bobby');
  await editor.press('Enter');
  await expect(rows.nth(1)).toContainText('Bobby');
  await expect.poll(() => scalar('SELECT name FROM customers WHERE id = 2')).toBe('Bobby');
});

test('runs queries with F9 and edits the result in place', async () => {
  await tab('Query').click();
  const ta = page.locator('.query-view .sqled-ta').first();
  await ta.fill('SELECT id, name FROM customers ORDER BY id');
  await ta.press('F9');
  await expect(page.locator('.res-tab', { hasText: 'Result #1 (3r × 2c)' })).toBeVisible();
  await expect(page.locator('.res-edit-info')).toHaveText(`Editable: ${schema}.customers`);

  const cell = page.locator('.q-results .gr').nth(2).locator('.gc').nth(2);
  await cell.dblclick();
  await page.locator('.q-results .grid-ed').fill('Caroline');
  await page.locator('.q-results .grid-ed').press('Enter');
  await expect.poll(() => scalar('SELECT name FROM customers WHERE id = 3')).toBe('Caroline');
});

test('asks before UPDATE/DELETE without WHERE and runs nothing on cancel', async () => {
  const ta = page.locator('.query-view .sqled-ta').first();
  await ta.fill('DELETE FROM logs');
  await ta.press('F9');
  const dlg = page.locator('.modal', { hasText: 'without WHERE' });
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.q-msg')).toContainText('cancelled');
  expect(await scalar('SELECT COUNT(*) FROM logs')).toBe('2');
});

test('table editor generates ALTER code', async () => {
  await treeNode('customers').click();
  await tab(/^Table/).click();
  await expect(page.locator('.table-view .edit-table tbody tr')).toHaveCount(3);
  const comment = page.locator('.tv-cols tbody tr').nth(1).locator('input.cell-inp').last();
  await comment.fill('display name');
  await page.locator('.tv-top .subtab', { hasText: 'ALTER code' }).click();
  await expect(page.locator('.tv-pane')).toContainText("COMMENT 'display name'");
  await page.locator('.table-view').getByRole('button', { name: 'Discard', exact: true }).click();
  await btn('OK').click();
  await expect(tab(/^Table/)).not.toHaveClass(/modified/);
});

test('opens the user manager', async () => {
  await page.locator('.menubar-item', { hasText: 'Tools' }).click();
  await page.locator('.menu-item', { hasText: 'User manager' }).click();
  const dlg = page.locator('.modal.user-manager');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.um-item').first()).toBeVisible();
  await dlg.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dlg).toHaveCount(0);
});

test('toggles dark mode', async () => {
  const html = page.locator('html');
  const before = await html.getAttribute('data-theme');
  await page.locator('#toolbar .tbtn').last().click();
  await expect(html).not.toHaveAttribute('data-theme', before);
  await page.locator('#toolbar .tbtn').last().click();
  await expect(html).toHaveAttribute('data-theme', before);
});

test('produced no JavaScript errors', () => {
  expect(pageErrors).toEqual([]);
});
