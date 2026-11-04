import { InvalidDomainInputError } from './domain-errors';

export function requireText(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidDomainInputError(`${field} is required`);
  }
}

export function dateCopy(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new InvalidDomainInputError('A valid date is required');
  }
  return new Date(value.getTime());
}

/** Copy only JSON values; freeze recursively, including nested arrays. */
export function immutableJson<T>(value: T): Readonly<T> {
  function copy(item: unknown): unknown {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return Object.freeze(item.map(copy));
    if (typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      return Object.freeze(Object.fromEntries(Object.entries(item).map(([k, v]) => [k, copy(v)])));
    }
    throw new InvalidDomainInputError('Payload must contain only JSON values');
  }
  return copy(value) as Readonly<T>;
}
