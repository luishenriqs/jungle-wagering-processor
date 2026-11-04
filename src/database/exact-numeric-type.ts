import { Type } from '@mikro-orm/core';

/** pg NUMERIC is a decimal string. Refuse driver configurations that parse it as a number. */
export class ExactNumericType extends Type<string, string> {
  override convertToDatabaseValue(value: string): string {
    if (typeof value !== 'string') throw new TypeError('NUMERIC must remain a decimal string');
    return value;
  }
  override convertToJSValue(value: string): string {
    if (typeof value !== 'string') throw new TypeError('NUMERIC was converted to number by the driver');
    return value;
  }
  override getColumnType(): string { return 'numeric(18,2)'; }
  override compareAsType(): string { return 'string'; }
}
