import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerBlocks, inlineParts } from '../../src/ZawSQL/wwwroot/js/claudelogic.js';

test('an answer splits into paragraphs, lists and code blocks', () => {
  const text = [
    'The column `nam` does not exist in',
    'customers.',
    '',
    '- Check the spelling',
    '- It is called `name`, wrapped',
    '  onto two lines',
    '1. numbered too',
    'After the list.',
    '```sql',
    'SELECT name FROM customers;',
    '```',
  ].join('\r\n');
  assert.deepEqual(answerBlocks(text), [
    { type: 'p', text: 'The column `nam` does not exist in customers.' },
    { type: 'ul', items: ['Check the spelling', 'It is called `name`, wrapped onto two lines', 'numbered too'] },
    { type: 'p', text: 'After the list.' },
    { type: 'code', lang: 'sql', text: 'SELECT name FROM customers;' },
  ]);
  // An unclosed fence still shows its code; empty input shows nothing.
  assert.deepEqual(answerBlocks('```\nSELECT 1'), [{ type: 'code', lang: '', text: 'SELECT 1' }]);
  assert.deepEqual(answerBlocks(''), []);
});

test('inline code is kept apart and bold markers are dropped', () => {
  assert.deepEqual(inlineParts('Use **an index** on `orders(customer_id)` here'), [
    { code: false, text: 'Use an index on ' },
    { code: true, text: 'orders(customer_id)' },
    { code: false, text: ' here' },
  ]);
  // Underscores inside names are not emphasis.
  assert.deepEqual(inlineParts('customer_id and __x__'), [{ code: false, text: 'customer_id and x' }]);
});
