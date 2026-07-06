import { describe, expect, it } from 'vitest';
import { DUNNING_LADDER_HOURS, evaluateDunningStep } from '../../src/subscriptions/dunning.js';

describe('evaluateDunningStep — T8.2', () => {
  it('allows the first retry (stage 0 -> 1) and schedules it per the ladder', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const decision = evaluateDunningStep(0, now);
    expect(decision.allowed).toBe(true);
    expect(decision.nextStage).toBe(1);
    expect(decision.nextRetryAt?.getTime()).toBe(
      now.getTime() + DUNNING_LADDER_HOURS[0]! * 3600_000,
    );
  });

  it('allows every stage up to the ladder length', () => {
    for (let stage = 0; stage < DUNNING_LADDER_HOURS.length; stage++) {
      expect(evaluateDunningStep(stage).allowed).toBe(true);
    }
  });

  it('refuses once the ladder is exhausted', () => {
    const decision = evaluateDunningStep(DUNNING_LADDER_HOURS.length);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/exhausted/i);
  });

  it('schedules increasing delays as the stage advances', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const first = evaluateDunningStep(0, now);
    const second = evaluateDunningStep(1, now);
    expect(second.nextRetryAt!.getTime() - now.getTime()).toBeGreaterThan(
      first.nextRetryAt!.getTime() - now.getTime(),
    );
  });
});
