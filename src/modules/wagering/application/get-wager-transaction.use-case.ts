import type { FinancialUnitOfWork } from '../../../shared/application/financial-store';
import { NotFoundError } from '../../../shared/application/application-errors';
import { internalId } from '../../../shared/application/identifiers';
import { requireText } from '../../../shared/domain/validation';

export class GetWagerTransactionUseCase {
  constructor(private readonly uow: FinancialUnitOfWork) {}
  async execute(input: { id: string } | { providerId: string; externalTransactionId: string }) {
    return this.uow.run(async store => {
      if (!('id' in input)) { requireText(input.providerId, 'providerId'); requireText(input.externalTransactionId, 'externalTransactionId'); }
      const tx = 'id' in input ? await store.getWager(internalId(input.id)) : await store.findWager(input.providerId, input.externalTransactionId);
      if (!tx) throw new NotFoundError('Wager transaction not found');
      return tx;
    });
  }
}
