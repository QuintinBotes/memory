export function price(amount, currency) {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}
