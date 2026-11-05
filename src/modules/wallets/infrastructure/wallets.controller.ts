import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { CreateWalletUseCase } from '../application/create-wallet.use-case';
import { GetWalletUseCase } from '../application/wallet-queries';
import { internalId } from '../../../shared/application/identifiers';
import { ProviderIdentityGuard } from '../../../shared/infrastructure/provider-identity.guard';
import { createWalletHttpInput, toWalletHttpResponse } from './wallet-http.dto';

@Controller('wallets')
@UseGuards(ProviderIdentityGuard)
export class WalletsController {
  constructor(@Inject(CreateWalletUseCase) private readonly create: CreateWalletUseCase,
    @Inject(GetWalletUseCase) private readonly get: GetWalletUseCase) {}

  @Post()
  async open(@Body() body: unknown, @Req() request: { correlationId: string }) {
    return toWalletHttpResponse(await this.create.execute({ ...createWalletHttpInput(body), correlationId: request.correlationId }));
  }
  @Get(':walletId')
  async find(@Param('walletId') walletId: string) {
    return toWalletHttpResponse(await this.get.execute(internalId(walletId)));
  }
}
