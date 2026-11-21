let spent = 0;

export function consume(amount) {
  spent += amount;
  return spent;
}

export const total = () => spent;
