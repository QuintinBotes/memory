import { price } from './price.mjs';

export const cartLine = (item) => `${item.name}: ${price(item.cents, 'EUR')}`;
