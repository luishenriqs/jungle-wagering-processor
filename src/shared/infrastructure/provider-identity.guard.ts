import { Injectable, type CanActivate } from '@nestjs/common';

/** Extension point only: permits every request. No authentication or IdP is implemented in CP-01. */
@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  canActivate(): boolean { return true; }
}
