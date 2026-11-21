import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (path) => import(pathToFileURL(join(process.env.LAB_REPO, path)).href);
const { price } = await load('src/price.mjs');
const { cartLine } = await load('src/cart.mjs');
const { invoiceTotal } = await load('src/invoice.mjs');
const { summary } = await load('src/report/summary.mjs');

test('price takes one object', () => assert.equal(price({ amount: 100, currency: 'EUR' }), '1.00 EUR'));

test('every caller of price still works, the aliased one included', () => {
  assert.equal(cartLine({ name: 'tea', cents: 250 }), 'tea: 2.50 EUR');
  assert.equal(invoiceTotal(1000), 'Total 10.00 EUR');
  assert.equal(summary([{ cents: 100, currency: 'USD' }]), '1.00 USD');
});
