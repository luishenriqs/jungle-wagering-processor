import { InvalidDomainInputError } from '../domain/domain-errors';

export function internalId(id: string): string {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new InvalidDomainInputError('Expected an internal UUID identifier');
  }
  return id.toLowerCase();
}
