import { PersistenceInvariantError } from '../shared/application/application-errors';

/** Normalize raw TIMESTAMPTZ values before crossing the domain boundary. */
export function databaseTimestamp(value: unknown, column: string): Date {
  const invalid = () => new PersistenceInvariantError(`Invalid PostgreSQL timestamp in ${column}`);
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw invalid();
    return new Date(value.getTime());
  }
  if (typeof value !== 'string') throw invalid();
  // PostgreSQL text and ISO-8601 forms, always with an explicit timezone.
  const parts = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(value);
  if (!parts) throw invalid();
  const milliseconds = (parts[3] ?? '').padEnd(3, '0').slice(0, 3);
  const local = `${parts[1]}T${parts[2]}.${milliseconds}`;
  const calendar = new Date(`${local}Z`);
  // Reject calendar rollovers such as February 30 instead of silently normalizing them.
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString() !== `${local}Z`) throw invalid();
  const zone = parts[4]!.replace(/^([+-]\d{2})$/, '$1:00').replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  const date = new Date(`${local}${zone}`);
  if (!Number.isFinite(date.getTime())) throw invalid();
  return date;
}

export function nullableDatabaseTimestamp(value: unknown, column: string): Date | undefined {
  return value === null ? undefined : databaseTimestamp(value, column);
}
