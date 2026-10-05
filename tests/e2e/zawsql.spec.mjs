import { readFileSync } from 'node:fs';
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
    "INSERT INTO logs VALUES ('a'), ('b')",
    'CREATE TABLE sp_sales (id INT NOT NULL, y INT NOT NULL, PRIMARY KEY (id, y)) PARTITION BY RANGE (y) (PARTITION p0 VALUES LESS THAN (2000), PARTITION pmax VALUES LESS THAN MAXVALUE)',
    'INSERT INTO sp_sales VALUES (1, 1999), (2, 2005), (3, 2010)');

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

test('remembers WHERE filters per table and offers them in a drop-down', async () => {
  const view = page.locator('.data-view');
  const rows = view.locator('.gr');
  const where = view.locator('.filter-box textarea');
  await view.getByRole('button', { name: 'Filter', exact: true }).click();
  await where.fill("status = 'blocked'");
  await where.press('Enter');
  await expect(rows).toHaveCount(1);
  await where.fill('id > 1');
  await where.press('Enter');
  await expect(rows).toHaveCount(2);
  // A filter that fails isn't remembered.
  await where.fill('no_such_column = 1');
  await where.press('Enter');
  await expect(page.locator('.modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await view.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(rows).toHaveCount(3);

  await view.locator('.filter-hist').click();
  const items = page.locator('.ctx-root .menu-item');
  await expect(items.nth(0)).toHaveText(/id > 1/);
  await expect(items.nth(1)).toHaveText(/status = 'blocked'/);
  await expect(page.locator('.ctx-root')).not.toContainText('no_such_column');
  await items.nth(1).click();
  await expect(where).toHaveValue("status = 'blocked'");
  await expect(rows).toHaveCount(1);

  // From the keyboard: Alt+Down opens the list, Down and Enter pick an entry.
  await where.press('Alt+ArrowDown');
  await expect(page.locator('.ctx-root')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(where).toHaveValue("status = 'blocked'"); // picked again: now the most recent entry
  await where.press('Alt+ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(where).toHaveValue('id > 1');
  await expect(rows).toHaveCount(2);

  await view.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(rows).toHaveCount(3);
  await view.getByRole('button', { name: 'Filter', exact: true }).click();
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

test('the SQL log shows a timestamp with milliseconds on every line, and can hide them', async () => {
  const log = page.locator('#log');
  const last = log.locator('.log-line', { hasText: 'SELECT id, name FROM customers ORDER BY id' }).last();
  await expect(last.locator('.log-ts')).toHaveText(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/);
  await log.click({ button: 'right' });
  await page.locator('.ctx-root .menu-item', { hasText: 'Show timestamps' }).click();
  await expect(last.locator('.log-ts')).toBeHidden();
  await log.click({ button: 'right' });
  await page.locator('.ctx-root .menu-item', { hasText: 'Show timestamps' }).click();
  await expect(last.locator('.log-ts')).toBeVisible();
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

test('asks for :name query parameters, checks them and remembers them', async () => {
  const ta = page.locator('.query-view .sqled-ta').first();
  await ta.fill('SELECT id, name FROM customers WHERE status = :status ORDER BY id LIMIT :n');
  await ta.press('F9');
  const dlg = page.locator('.modal.qp-dialog');
  await expect(dlg.locator('.modal-title > span')).toHaveText('Query parameters (2)');
  const value = i => dlg.locator('.qp-value').nth(i);
  await expect(dlg.locator('.qp-type').nth(0)).toHaveValue('text');
  await expect(dlg.locator('.qp-type').nth(1)).toHaveValue('number'); // LIMIT only takes a number
  await value(0).fill("active");
  await value(1).fill('abc');
  await dlg.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(dlg.locator('.qp-err').nth(1)).toHaveText('"abc" isn\'t a number.');
  await expect(dlg.locator('.qp-err').nth(0)).toBeEmpty();
  await value(1).fill('1');
  await expect(dlg.locator('.qp-preview')).toHaveText("SELECT id, name FROM customers WHERE status = 'active' ORDER BY id LIMIT 1");
  await value(1).press('Enter');
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('.res-tab', { hasText: 'Result #1 (1r × 2c)' })).toBeVisible();
  await expect(ta).toHaveValue(/= :status ORDER BY id LIMIT :n$/); // the editor keeps the placeholders

  // The next run offers the values used last; cancelling runs nothing.
  await ta.press('F9');
  await expect(value(0)).toHaveValue('active');
  await expect(value(1)).toHaveValue('1');
  await dlg.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.q-msg')).toContainText('cancelled');
});

test('manual commit keeps changes in a transaction until commit or rollback', async () => {
  const ta = page.locator('.query-view .sqled-ta').first();
  const mode = page.locator('.tab-pane.active .tx-mode');
  const info = page.locator('.tab-pane.active .tx-info');
  const status = () => scalar('SELECT status FROM customers WHERE id = 3'); // through another connection
  await expect(mode).toHaveText('Auto-commit');
  // Running right after switching (before the tab's connection is open) must still use the transaction.
  await ta.fill("UPDATE customers SET status = 'blocked' WHERE id = 3");
  await mode.click();
  await ta.press('F9');
  await expect(mode).toHaveText('Manual commit');
  await expect(info).toHaveText('Transaction open · 1 change · just now');
  await expect(page.locator('#tabbar .tab.active')).toHaveClass(/tx-open/);
  expect(await status()).toBe('active'); // nobody else sees it yet

  await page.locator('.tab-pane.active').getByRole('button', { name: 'Rollback', exact: true }).click();
  await expect(page.locator('.tab-pane.active .q-msg')).toHaveText('Rolled back 1 change.');
  await expect(info).toHaveText('No open transaction');
  await expect(page.locator('#tabbar .tab.active')).not.toHaveClass(/tx-open/);

  await ta.press('F9');
  await page.locator('.tab-pane.active').getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page.locator('.tab-pane.active .q-msg')).toHaveText('Committed 1 change.');
  expect(await status()).toBe('blocked');

  // Leaving manual mode with something open asks what to do with it.
  await ta.fill("UPDATE customers SET status = 'active' WHERE id = 3");
  await ta.press('F9');
  await expect(info).toHaveText(/Transaction open · 1 change/);
  await mode.click();
  const dlg = page.locator('.modal', { hasText: 'open transaction with 1 uncommitted change' });
  await expect(dlg).toContainText('Switching to auto-commit ends it.');
  await dlg.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(mode).toHaveText('Auto-commit');
  expect(await status()).toBe('active');
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

test('visual EXPLAIN shows the plan, what to look at, and measured steps', async () => {
  await page.locator('#tabbar .tab-add').click();
  const ta = page.locator('.tab-pane.active .sqled-ta');
  await ta.fill('SELECT 1;\n\nSELECT c.name, l.msg FROM customers c JOIN logs l ON l.msg = c.name ORDER BY c.name;');
  await ta.evaluate(el => el.setSelectionRange(el.value.length - 5, el.value.length - 5)); // cursor in the second statement
  await ta.press('Control+Shift+E');
  const xp = page.locator('.tab-pane.active .xp');
  await expect(page.locator('.tab-pane.active .res-tab.res-plan')).toHaveClass(/active/);
  await expect(xp.locator('.xp-card.xp-table')).toHaveCount(2);
  expect((await xp.locator('.xp-card.xp-table .xp-name').allTextContents()).sort()).toEqual(['c', 'l']); // plans name tables by alias
  // logs has no index on msg: the join can't use one.
  await expect(xp.locator('.xp-issues')).toContainText('joined without an index');
  await expect(xp.locator('.xp-caption')).toContainText('Estimated plan · 2 tables');

  await xp.locator('.subtab', { hasText: 'Table' }).click();
  await expect(xp.locator('.xp-grid .gr')).toHaveCount(2);
  await xp.locator('.subtab', { hasText: 'JSON' }).click();
  await expect(xp.locator('.xp-json')).toContainText('"query_block"');

  await xp.getByRole('button', { name: 'Analyze (runs it)' }).click();
  await expect(xp.locator('.xp-caption')).toContainText('Measured plan');
  if (await xp.locator('.subtab', { hasText: 'Measured' }).count()) { // MySQL: EXPLAIN ANALYZE steps
    await expect(xp.locator('.subtab.active')).toHaveText('Measured');
    await expect(xp.locator('.xp-steps tbody tr').first()).toBeVisible();
  } else { // MariaDB: ANALYZE FORMAT=JSON adds actuals to the diagram
    await expect(xp.locator('.subtab.active')).toHaveText('Diagram');
    await expect(xp.locator('.xp-card.xp-table')).toHaveCount(2);
  }

  // Running a query keeps the plan one click away.
  await ta.press('F9');
  await expect(page.locator('.tab-pane.active .res-tab').first()).toHaveClass(/active/);
  await page.locator('.tab-pane.active .res-tab.res-plan').click();
  await expect(xp).toBeVisible();
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

test('partition editor adds, names and checks subpartitions', async () => {
  const subNames = () => scalar(`SELECT GROUP_CONCAT(SUBPARTITION_NAME ORDER BY PARTITION_ORDINAL_POSITION, SUBPARTITION_ORDINAL_POSITION) FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = '${schema}' AND TABLE_NAME = 'sp_sales'`);
  const view = page.locator('.table-view');
  const openPartitions = async () => {
    await view.locator('.tv-top .subtab', { hasText: 'Partitions' }).click();
    await expect(view.locator('.part-editor')).toBeVisible();
  };
  const save = async () => {
    await view.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(tab(/^Table/)).not.toHaveClass(/modified/);
  };
  await treeNode('sp_sales').click();
  await tab(/^Table/).click();
  await openPartitions();
  const sub = view.locator('.part-editor');

  // Subpartition the RANGE partitions by HASH; the server names them.
  await sub.locator('.part-sub-method select').selectOption('HASH');
  await sub.locator('.part-sub-expr input').fill('id');
  await sub.locator('.part-sub-count input').fill('2');
  await expect(view.locator('.part-editor .edit-table tbody tr').first()).toContainText('p0sp0, p0sp1');
  await view.locator('.tv-top .subtab', { hasText: 'ALTER code' }).click();
  await expect(view.locator('.tv-pane')).toContainText('SUBPARTITION BY HASH (id)\nSUBPARTITIONS 2');
  await save();
  expect(await subNames()).toBe('p0sp0,p0sp1,pmaxsp0,pmaxsp1');
  expect(await scalar('SELECT COUNT(*) FROM sp_sales')).toBe('3'); // nothing lost

  // Name them: the names the server gave are offered, then changed for p0.
  await openPartitions();
  await sub.locator('.part-sub-named input').check();
  const p0subs = view.locator('.part-editor .edit-table tbody tr').first().locator('td').nth(4).locator('input');
  await expect(p0subs).toHaveValue('p0sp0, p0sp1');
  await p0subs.fill('old_a, old_b');
  await save();
  expect(await subNames()).toBe('old_a,old_b,pmaxsp0,pmaxsp1');

  // Options: a default for p0's subpartitions, and old_a's own comment and MAX_ROWS.
  await openPartitions();
  await view.locator('.part-editor .edit-table tbody tr').first().locator('.part-opts-btn').click();
  const dlg = page.locator('.modal.po-dialog');
  await dlg.locator('label.frow', { hasText: 'Min rows:' }).locator('input').fill('5');
  const oldA = dlg.locator('.po-subs tbody tr').first().locator('td');
  await oldA.nth(1).locator('input').fill('hot data');
  await oldA.nth(4).locator('input').fill('100');
  await dlg.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(view.locator('.part-editor .edit-table tbody tr').first().locator('.part-opts-btn')).toHaveClass(/has-opts/);
  await view.locator('.tv-top .subtab', { hasText: 'ALTER code' }).click();
  await expect(view.locator('.tv-pane')).toContainText('REORGANIZE PARTITION `p0` INTO'); // only p0 is rebuilt
  await save();
  const create = (await exec('SHOW CREATE TABLE sp_sales')).resultSets[0].rows[0][1];
  expect(create).toMatch(/SUBPARTITION `?old_a`? MAX_ROWS = 100 MIN_ROWS = 5 COMMENT = 'hot data'/);
  expect(create).toMatch(/SUBPARTITION `?old_b`? MIN_ROWS = 5/);
  expect(await scalar('SELECT COUNT(*) FROM sp_sales')).toBe('3');
  // Read back, the shared MIN_ROWS is the partition's again and old_a keeps its own options.
  await openPartitions();
  await view.locator('.part-editor .edit-table tbody tr').first().locator('.part-opts-btn').click();
  await expect(dlg.locator('label.frow', { hasText: 'Min rows:' }).locator('input')).toHaveValue('5');
  await expect(oldA.nth(1).locator('input')).toHaveValue('hot data');
  await dlg.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(tab(/^Table/)).not.toHaveClass(/modified/);

  // What the server would refuse is caught first: a partition with fewer subpartitions.
  await openPartitions();
  await p0subs.fill('old_a');
  await expect(view.locator('.part-problems')).toHaveText(/Every partition needs the same number of subpartitions/);
  await view.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.modal')).toContainText('Partitions: Every partition needs the same number of subpartitions.');
  await page.keyboard.press('Escape');
  expect(await subNames()).toBe('old_a,old_b,pmaxsp0,pmaxsp1');
  await view.getByRole('button', { name: 'Discard', exact: true }).click();
  await btn('OK').click();
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
  await expect(dlg.locator('.mt-status')).toContainText('3 of 3 table(s)'); // customers, logs, sp_sales
  await expect(dlg.locator('.grid .gr')).toHaveCount(3);
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

test('performance: top queries, open transactions and killing a lock holder', async () => {
  await page.locator('.tn.session').first().click();
  await tab(/^Host/).click();
  await page.locator('.host-view .subtab', { hasText: 'Performance' }).click();
  const ins = page.locator('.ins');
  await expect(ins.locator('.subtab.active')).toHaveText('Top queries');
  const statsOff = ins.getByText('Statement statistics are not available');
  await expect(ins.locator('.ins-qgrid .gr').first().or(statsOff)).toBeVisible();
  if (await statsOff.isVisible()) {
    // MariaDB ships with performance_schema off: the panel says so and how to turn it on.
    await expect(ins.getByText('performance_schema').first()).toBeVisible();
  } else {
    // MySQL 8.4 has performance_schema on: earlier tests' statements are listed with their timings.
    // System statements (ZawSQL's own metadata queries) are hidden by default.
    await expect(ins.locator('.ins-qgrid .gr', { hasText: 'information_schema' })).toHaveCount(0);
    await ins.locator('.ins-qbar input[type=search]').fill('select customers'); // every term must match
    const row = ins.locator('.ins-qgrid .gr', { hasText: 'FROM `customers`' }).first();
    await row.click();
    await expect(ins.locator('.ins-detail .ins-stat', { hasText: 'Executions' })).toBeVisible();
    await expect(ins.locator('.ins-detail .ins-sql')).toContainText('customers');
  }

  // An idle transaction holding a row lock, from another connection.
  await exec('START TRANSACTION', 'UPDATE customers SET name = name WHERE id = 1');
  await ins.locator('.subtab', { hasText: 'Locks & transactions' }).click();
  const trxRow = ins.locator('.ins-section', { hasText: 'Open transactions' }).locator('tbody tr', { hasText: schema });
  await expect(trxRow).toHaveCount(1);
  await expect(ins.locator('.ins-section', { hasText: 'Row lock waits' })).toContainText('No transaction is waiting');
  await trxRow.getByRole('button', { name: 'Kill' }).click();
  await btn('Kill').click();
  await expect(trxRow).toHaveCount(0);
  await ins.locator('.subtab', { hasText: 'Top queries' }).click();
  await page.locator('.host-view .subtab', { hasText: 'Databases' }).click();
});

test('replication status of the server', async () => {
  await page.locator('.tn.session').first().click();
  await tab(/^Host/).click();
  await page.locator('.host-view .subtab', { hasText: 'Replication' }).click();
  const rp = page.locator('.rp');
  await expect(rp.locator('.rp-role-text')).toHaveText(/^(Primary with \d+ replicas?|Not replicating – binary log (on, no replicas connected|off)|Replica of .+)$/);
  await expect(rp.locator('.rp-facts')).toContainText('server_id');
  const role = await rp.locator('.rp-role-text').textContent();
  if (role.startsWith('Primary')) {
    await expect(rp.locator('.rp-card', { hasText: 'As a primary' }).locator('.rp-table tbody tr').first()).toBeVisible();
    await expect(rp.locator('.rp-details')).toContainText('Binary log position');
  }
  await page.locator('.host-view .subtab', { hasText: 'Databases' }).click();
});

test('server health report: findings, filters, fixes and the saved HTML', async () => {
  await page.locator('.tn.session').first().click();
  await page.locator('.menubar-item', { hasText: 'Tools' }).click();
  await page.locator('.menu-item', { hasText: 'Server health report' }).click();
  await expect(page.locator('.host-view > .viewbar .subtab.active')).toHaveText('Health');
  const hl = page.locator('.hl');
  await expect(hl.locator('.hl-verdict')).toBeVisible();
  // The e2e schema's logs table has no primary key.
  const pk = hl.locator('.hl-finding[data-id="primary-keys"]');
  await expect(pk).toContainText(`${schema}.logs`);
  await expect(pk.locator('.hl-sql')).toContainText('ADD COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST');
  await expect(hl.locator('.hl-overview')).toContainText('Largest tables');

  await hl.locator('.hl-chip', { hasText: 'Passed' }).click();
  await expect(hl.locator('.hl-passed li').first()).toBeVisible();
  await expect(hl.locator('.hl-finding')).toHaveCount(0);
  await hl.locator('.hl-chip', { hasText: 'Warnings' }).click();
  await expect(hl.locator('.hl-finding.sev-warning').first()).toBeVisible();
  await expect(hl.locator('.hl-finding:not(.sev-warning)')).toHaveCount(0);
  await hl.locator('.hl-chip', { hasText: 'All' }).click();

  // Saved as one self-contained page (the download path; the native save dialog is unavailable here).
  await page.evaluate(() => { window.showSaveFilePicker = undefined; });
  const [download] = await Promise.all([page.waitForEvent('download'), hl.getByRole('button', { name: 'Save as HTML…' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^health-.+-\d{4}-\d{2}-\d{2}\.html$/);
  const html = readFileSync(await download.path(), 'utf8');
  expect(html).toContain('<title>Health report');
  expect(html).toContain(`${schema}.logs`);

  // The fix opens in a query tab for review; nothing runs by itself.
  await pk.getByRole('button', { name: 'Open in query tab' }).click();
  await expect(page.locator('.tab-pane.active .sqled-ta')).toHaveValue(/-- Review before running\.\nALTER TABLE `[^`]+`\.`logs` ADD COLUMN id/);
  expect(await scalar(`SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '${schema}' AND TABLE_NAME = 'logs'`)).toBe('1');
  await page.locator('#tabbar .tab.active .tab-x').click();
  await tab(/^Host/).click();
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

test('imports a CSV file into a new table with the wizard', async () => {
  await treeNode(schema).click({ button: 'right' });
  await page.locator('.ctx-root .menu-item', { hasText: 'Import CSV / Excel' }).click();
  const dlg = page.locator('.modal.import-wizard');
  await expect(dlg).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await dlg.getByRole('button', { name: 'Choose file…' }).click();
  // Semicolons, decimal commas and day-first dates, as Excel writes CSV in many European locales.
  const csv = 'Product code;Name;Price;Added\nA-1;Widget;12,50;31.12.2024\nB-2;"Gadget; large";3;01.02.2025\n';
  await (await chooser).setFiles({ name: 'New Products.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(dlg.locator('.imp-info')).toHaveText('2 rows, 4 columns');
  await expect(dlg.locator('.grid .gr')).toHaveCount(2);
  await expect(dlg.locator('.grid')).toContainText('Gadget; large');

  await dlg.getByRole('button', { name: 'Next' }).click();
  await expect(dlg.locator('.imp-target input.inp').first()).toHaveValue('new_products');
  const types = dlg.locator('.imp-map tbody tr td:nth-child(5) input');
  await expect(types).toHaveCount(4);
  await expect(types.nth(2)).toHaveValue('DECIMAL(4,2)');
  await expect(types.nth(3)).toHaveValue('DATE');
  await dlg.locator('.imp-map tbody tr').first().locator('td:nth-child(4) input').fill('code');

  await dlg.getByRole('button', { name: 'Next' }).click();
  const opt = label => dlg.locator('.imp-opts label.frow', { hasText: label }).locator('select');
  await expect(opt('Decimal separator')).toHaveValue('true'); // suggested from the data
  await expect(opt('Dates')).toHaveValue('DMY');
  await expect(dlg.locator('.imp-sql')).toContainText('CREATE TABLE');
  await expect(dlg.locator('.imp-sql')).toContainText("('A-1', 'Widget', '12.50', '2024-12-31')");
  await dlg.getByRole('button', { name: 'Import 2 rows' }).click();
  await expect(dlg.locator('.imp-run-label')).toContainText('Done: 2 rows read');
  await expect(dlg.locator('.imp-stats')).toContainText('2 rows affected · 0 errors');
  await dlg.getByRole('button', { name: 'Open table' }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('.data-view .gr')).toHaveCount(2);
  expect(await scalar("SELECT CONCAT(code, '|', `Name`, '|', Price, '|', Added) FROM new_products ORDER BY code LIMIT 1")).toBe('A-1|Widget|12.50|2024-12-31');
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

test('imports sessions from a HeidiSQL settings export and connects with one', async () => {
  // HeidiSQL's password encoding: hex of each character shifted by the salt digit appended at the end (here 1).
  const heidiPassword = s => [...s].map(c => (c.charCodeAt(0) + 1).toString(16).padStart(2, '0')).join('') + '1';
  const name = 'Imported ' + schema;
  const settings = [
    `Servers\\E2E import\\${name}\\Host<|||>1<|||>${DB.host}`,
    `Servers\\E2E import\\${name}\\Port<|||>1<|||>${DB.port}`,
    `Servers\\E2E import\\${name}\\User<|||>1<|||>${DB.user}`,
    `Servers\\E2E import\\${name}\\Password<|||>1<|||>${heidiPassword(DB.password)}`,
    `Servers\\E2E import\\${name}\\NetType<|||>3<|||>0`,
    `Servers\\E2E import\\${name}\\Databases<|||>1<|||>${schema}`,
    'Servers\\Old PG\\Host<|||>1<|||>pg.example.com',
    'Servers\\Old PG\\NetType<|||>3<|||>8',
  ].join('\r\n');

  await page.locator('.menubar-item', { hasText: 'File' }).click();
  await page.locator('.menu-item', { hasText: 'Session manager' }).click();
  await btn('Import…').click();
  const dlg = page.locator('.modal.si-dialog');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    dlg.locator('.si-source[data-source="heidisql"]').getByRole('button', { name: 'Choose file…' }).click(),
  ]);
  await chooser.setFiles({ name: 'heidisql-settings.txt', mimeType: 'text/plain', buffer: Buffer.from(settings) });
  const rows = dlg.locator('.si-table tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.si-name')).toHaveValue(`E2E import / ${name}`);
  await expect(rows.nth(0)).toContainText('saved'); // the password came along
  await expect(rows.nth(1)).toContainText('Skipped: PostgreSQL session');
  // The suite's admin session is the same server: recognised and not selected, but it can be imported anyway.
  await expect(rows.nth(0)).toContainText('Already saved as "E2E admin"');
  await expect(rows.nth(0).locator('input[type=checkbox]')).not.toBeChecked();
  await rows.nth(0).locator('input[type=checkbox]').check();
  await dlg.getByRole('button', { name: 'Import 1 session' }).click();
  await expect(dlg).toHaveCount(0);

  // Back in the session manager, the imported session is selected and opens without asking for a password.
  await expect(page.locator('.sm-item.sel')).toContainText(`E2E import / ${name}`);
  await expect(field('Databases:')).toHaveValue(schema);
  await btn('Open').click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator('.tn.session', { hasText: `E2E import / ${name}` })).toBeVisible();
  await expect(page.locator('#statusbar')).toContainText('Connected');
});

test('produced no JavaScript errors', () => {
  expect(pageErrors).toEqual([]);
});
