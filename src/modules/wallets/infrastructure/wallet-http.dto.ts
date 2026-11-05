import { InvalidDomainInputError } from '../../../shared/domain/domain-errors';
import { Money } from '../../../shared/domain/money';
import { requireText } from '../../../shared/domain/validation';
import type { Wallet } from '../domain/wallet';

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidDomainInputError('Expected object');
  if (Object.keys(value).some(key => !keys.includes(key))) throw new InvalidDomainInputError('Unknown field');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidDomainInputError('Expected string');
  requireText(value, 'value');
  return value;
}
export function createWalletHttpInput(body: unknown) {
  const root = object(body, ['playerId', 'initialBalance']);
  const balance = object(root['initialBalance'], ['amount', 'currency']);
  return { playerId: text(root['playerId']), initialBalance: Money.from({ amount: text(balance['amount']), currency: text(balance['currency']) }).toJSON() };
}
export function toWalletHttpResponse(wallet: Wallet) {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}
