import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { GetWagerTransactionUseCase } from '../application/get-wager-transaction.use-case';
import { internalId } from '../../../shared/application/identifiers';
import { NotFoundError, WagerNotFoundError } from '../../../shared/application/application-errors';
import { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction.use-case';
import { ProviderIdentityGuard } from '../../../shared/infrastructure/provider-identity.guard';
import { wagerHttpInput, wagerHttpStatus, wagerQueryText, toWagerHttpResponse, type WagerHttpRequest } from './wager-http.dto';

@Controller()
@UseGuards(ProviderIdentityGuard)
export class WageringController {
  constructor(@Inject(ProcessWagerTransactionUseCase) private readonly process: ProcessWagerTransactionUseCase,
    @Inject(GetWagerTransactionUseCase) private readonly get: GetWagerTransactionUseCase) {}

  @Post('wagering/transactions')
  @HttpCode(200)
  async submit(@Body() body: unknown, @Req() request: WagerHttpRequest,
    @Res({ passthrough: true }) response: { status(code: number): unknown }) {
    const result = await this.process.execute(wagerHttpInput(body, request));
    response.status(wagerHttpStatus(result));
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async find(@Param('transactionId') transactionId: string) {
    return this.query({ id: internalId(transactionId) });
  }
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async findExternal(@Param('providerId') providerId: string, @Param('externalTransactionId') externalId: string) {
    return this.query({ providerId: wagerQueryText(providerId), externalTransactionId: wagerQueryText(externalId) });
  }
  private async query(input: Parameters<GetWagerTransactionUseCase['execute']>[0]) {
    try { return toWagerHttpResponse(await this.get.execute(input)); }
    catch (error) {
      if (error instanceof NotFoundError) throw new WagerNotFoundError('Wager transaction not found', { cause: error });
      throw error;
    }
  }
}
