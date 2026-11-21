import { price } from './price.mjs';

export const invoiceTotal = (cents) => `Total ${price(cents, 'EUR')}`;
