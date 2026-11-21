import { price as toPrice } from '../price.mjs';

export const summary = (rows) => rows.map((r) => toPrice(r.cents, r.currency)).join(', ');
