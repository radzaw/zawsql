import { test, expect, request as playwrightRequest } from '@playwright/test';
import { PORT, TOKEN, DB, SSH } from './env.mjs';

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

test('saves queries to the library and expands snippets', async () => {
  const name = 'Active ' + schema;
  const ta = page.locator('.query-view .sqled-ta').first();
  await tab('Query').click();
  await ta.fill("SELECT * FROM customers WHERE status = 'active'");
  await ta.press('Control+s');
  const dlg = page.locator('.modal.lib-dialog');
  await expect(dlg.locator('.modal-title')).toHaveText(/Save query to library/);
  await dlg.locator('label.frow', { hasText: 'Name:' }).locator('input').fill(name);
  await dlg.locator('label.frow', { hasText: 'Folder:' }).locator('input').fill('E2E/Reports');
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dlg).toHaveCount(0);
  const qtab = tab(name);
  await expect(qtab).toHaveClass(/active/);

  // Editing marks the tab modified; Ctrl+S updates the saved query without asking.
  await ta.fill("SELECT id, name FROM customers WHERE status = 'active'");
  await expect(qtab).toHaveClass(/modified/);
  await ta.press('Control+s');
  await expect(qtab).not.toHaveClass(/modified/);
  const lib = await call('GET', '/library');
  expect(lib.queries.find(q => q.name === name)).toMatchObject({ folder: 'E2E/Reports', sql: "SELECT id, name FROM customers WHERE status = 'active'" });

  // The panel lists it under its folder; opening it from another tab switches back to the linked tab.
  await page.locator('.query-view .tbtn[title="Saved queries and snippets"]').first().click();
  const panel = page.locator('.tab-pane.active .lib-panel');
  await expect(panel.locator('.lib-folder', { hasText: 'E2E/Reports' })).toBeVisible();
  await page.locator('#tabbar .tab-add').click();
  const panel2 = page.locator('.tab-pane.active .lib-panel');
  await panel2.locator('.lib-filter').fill(schema);
  await panel2.locator('.lib-item', { hasText: name }).dblclick();
  await expect(qtab).toHaveClass(/active/);

  // Snippets: trigger + Tab, then Tab through the fields.
  await tab(/^Query #/).last().click();
  const ta2 = page.locator('.tab-pane.active .sqled-ta');
  await ta2.click();
  await page.keyboard.type('sel');
  await page.keyboard.press('Tab');
  await expect(page.locator('.tab-pane.active .sqled')).toHaveClass(/snippet-active/);
  await page.keyboard.type('logs');
  await page.keyboard.press('Tab');
  await page.keyboard.type('msg');
  await page.keyboard.press('Escape');
  await expect(ta2).toHaveValue('SELECT msg\nFROM logs\nWHERE 1 = 1\nLIMIT 100;');
  await ta2.press('F9');
  await expect(page.locator('.tab-pane.active .res-tab', { hasText: 'Result #1 (2r × 1c)' })).toBeVisible();

  // Inserting from the panel wraps the selection.
  await ta2.fill('DELETE FROM logs WHERE 0;');
  await ta2.press('Control+a');
  const p2 = page.locator('.tab-pane.active .lib-panel');
  await p2.locator('.subtab', { hasText: 'Snippets' }).click();
  await p2.locator('.lib-filter').fill('transaction');
  await p2.locator('.lib-item').first().dblclick();
  await expect(ta2).toHaveValue('START TRANSACTION;\nDELETE FROM logs WHERE 0;\nCOMMIT;');
  await p2.locator('.subtab', { hasText: 'Saved queries' }).click();
  await p2.locator('.tbtn[title="Hide panel"]').click();
  await expect(page.locator('.lib-panel:visible')).toHaveCount(0);
  await page.locator('#tabbar .tab.active .tab-x').click();
});

test('formats SQL with Ctrl+Shift+F; undo restores it', async () => {
  await page.locator('#tabbar .tab-add').click();
  const ta = page.locator('.tab-pane.active .sqled-ta');
  const messy = "select id, name from customers where status = 'active' and id > 1 order by name";
  await ta.fill(messy);
  await ta.press('Control+Shift+F');
  await expect(ta).toHaveValue("SELECT id, name\nFROM customers\nWHERE status = 'active'\n  AND id > 1\nORDER BY name");
  await expect(page.locator('#statusbar')).toContainText('SQL formatted');
  await ta.press('Control+z');
  await expect(ta).toHaveValue(messy);

  // Only the selection is formatted when there is one.
  await ta.fill('select 1;\nselect msg from logs where msg is not null;');
  await ta.evaluate(el => el.setSelectionRange(10, el.value.length));
  await page.locator('.tab-pane.active .tbtn[title^="Format SQL"]').click();
  await expect(ta).toHaveValue('select 1;\nSELECT msg\nFROM logs\nWHERE msg IS NOT NULL;');
  await ta.press('F9');
  await expect(page.locator('.tab-pane.active .res-tab', { hasText: 'Result #2 (2r × 1c)' })).toBeVisible();
  await page.locator('#tabbar .tab.active .tab-x').click();
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

test('runs table maintenance from the tree context menu', async () => {
  await treeNode('customers').click({ button: 'right' });
  await page.locator('.ctx-root .menu-item', { hasText: 'Maintenance' }).click();
  const dlg = page.locator('.modal.maintenance');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.mt-item input:checked')).toHaveCount(1); // only the clicked table
  await dlg.locator('.mt-op', { hasText: 'Checksum' }).locator('input').check();
  await expect(dlg.locator('.mt-preview')).toHaveText(`CHECKSUM TABLE \`${schema}\`.\`customers\``);
  await dlg.locator('.mt-op', { hasText: 'Check' }).first().locator('input').check();
  await dlg.locator('.mt-tables').getByRole('button', { name: 'All', exact: true }).click();
  await dlg.getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(dlg.locator('.mt-status')).toContainText('2 of 2 table(s)');
  await expect(dlg.locator('.grid .gr')).toHaveCount(2);
  await expect(dlg.locator('.grid')).toContainText('OK');
  await btn('Close').click();
  await expect(dlg).toHaveCount(0);
});

test('server monitor shows live charts, tooltips and a table view', async () => {
  await page.locator('.tn.session').first().click();
  await tab(/^Host/).click();
  await page.locator('.host-view .subtab', { hasText: 'Monitor' }).click();
  const mon = page.locator('.mon');
  await expect(mon.locator('.mon-tile')).toHaveCount(6);
  await expect(mon.locator('.mon-card')).toHaveCount(5);
  // Two samples are needed for rates; then every chart draws lines.
  await expect(mon.locator('.mon-card').first().locator('path.mon-line')).toHaveCount(5, { timeout: 15_000 });
  await expect(mon.locator('.mon-tile', { hasText: 'Connections' })).toContainText('max');

  const plot = mon.locator('.mon-card').nth(1).locator('svg');
  const box = await plot.boundingBox();
  await page.mouse.move(box.x + box.width - 20, box.y + 60);
  const tip = mon.locator('.mon-card').nth(1).locator('.mon-tip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Connected');
  await plot.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tip).toBeVisible();

  await mon.getByRole('button', { name: 'Table view' }).click();
  await expect(mon.locator('.mon-table-wrap tbody tr')).toHaveCount(16);
  await mon.getByRole('button', { name: 'Chart view' }).click();
  await mon.getByRole('button', { name: 'Pause' }).click();
  await expect(mon.getByRole('button', { name: 'Resume' })).toBeVisible();
  await mon.getByRole('button', { name: 'Resume' }).click();
  await page.locator('.host-view .subtab', { hasText: 'Databases' }).click();
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

test('connects through an SSH tunnel after confirming the host key', async () => {
  test.skip(!SSH.host, 'Set ZAWSQL_TEST_SSH_HOST (see tests/ssh) to run the SSH tunnel test.');
  await page.locator('#toolbar .tbtn[title="Session manager"]').click();
  await btn('New').click();
  await field('Session name:').fill('SSH ' + schema);
  await field('Hostname / IP:').fill(SSH.dbHost);
  await field('User:').fill(DB.user);
  await field('Password:').fill(DB.password);
  await field('Port:').fill(String(SSH.dbPort));
  await page.locator('.sm-form label.chk', { hasText: 'SSH tunnel' }).locator('input').check();
  await field('SSH host:').fill(SSH.host);
  await field('SSH port:').fill(String(SSH.port));
  await field('SSH user:').fill(SSH.user);
  await field('SSH password:').fill(SSH.password);
  await btn('Save').click();
  await btn('Open').click();

  const keyDlg = page.locator('.modal', { hasText: 'Unknown SSH host key' });
  await expect(keyDlg).toBeVisible();
  await expect(keyDlg).toContainText('SHA256:');
  await keyDlg.getByRole('button', { name: 'Trust and connect', exact: true }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator('.tn.session', { hasText: 'SSH ' + schema })).toBeVisible();
  await expect(page.locator('#log')).toContainText('SSH tunnel ready');
});

test('produced no JavaScript errors', () => {
  expect(pageErrors).toEqual([]);
});
