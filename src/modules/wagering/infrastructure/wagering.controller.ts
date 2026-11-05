import { Body, Controller, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction.use-case';
import { ProviderIdentityGuard } from '../../../shared/infrastructure/provider-identity.guard';
import { wagerHttpInput, wagerHttpStatus, type WagerHttpRequest } from './wager-http.dto';

@Controller('wagering/transactions')
@UseGuards(ProviderIdentityGuard)
export class WageringController {
  constructor(@Inject(ProcessWagerTransactionUseCase) private readonly process: ProcessWagerTransactionUseCase) {}

  @Post()
  @HttpCode(200)
  async submit(@Body() body: unknown, @Req() request: WagerHttpRequest,
    @Res({ passthrough: true }) response: { status(code: number): unknown }) {
    const result = await this.process.execute(wagerHttpInput(body, request));
    response.status(wagerHttpStatus(result));
    return result;
  }
}
