export function assertExhaustive(value: never, message = 'Unhandled variant'): never {
  throw new Error(`${message}: ${String(value)}`);
}
