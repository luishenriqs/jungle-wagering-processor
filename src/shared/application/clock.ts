/** UTC wall clock shared by scheduling, leases and tests; never monetary arithmetic. */
export interface ClockPort { now(): Date }
export class SystemClock implements ClockPort { now(): Date { return new Date(); } }
export const CLOCK = Symbol('CLOCK');
