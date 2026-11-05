import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { CreateWalletUseCase } from '../application/create-wallet.use-case';
import { GetWalletUseCase, ListWalletLedgerUseCase } from '../application/wallet-queries';
import { internalId } from '../../../shared/application/identifiers';
import { ProviderIdentityGuard } from '../../../shared/infrastructure/provider-identity.guard';
import { createWalletHttpInput, toWalletHttpResponse, ledgerHttpQuery, toLedgerHttpResponse } from './wallet-http.dto';

@Controller('wallets')
@UseGuards(ProviderIdentityGuard)
export class WalletsController {
  constructor(@Inject(CreateWalletUseCase) private readonly create: CreateWalletUseCase,
    @Inject(GetWalletUseCase) private readonly get: GetWalletUseCase,
    @Inject(ListWalletLedgerUseCase) private readonly listLedger: ListWalletLedgerUseCase) {}

  @Post()
  async open(@Body() body: unknown, @Req() request: { correlationId: string }) {
    return toWalletHttpResponse(await this.create.execute({ ...createWalletHttpInput(body), correlationId: request.correlationId }));
  }
  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query() query: unknown) {
    const id = internalId(walletId);
    return toLedgerHttpResponse(await this.listLedger.execute({ walletId: id, ...ledgerHttpQuery(query) }));
  }
  @Get(':walletId')
  async find(@Param('walletId') walletId: string) {
    return toWalletHttpResponse(await this.get.execute(internalId(walletId)));
  }
}
