import { describe, expect, it } from 'vitest';
import { LITE_PRIORITY_RANK } from '../types.js';

describe('Lite priority contract', () => {
  it('enforces strict V3 ordering P0 > STAFF > P1 > P2 independent of source preference', () => {
    expect(LITE_PRIORITY_RANK.P0).toBeLessThan(LITE_PRIORITY_RANK.STAFF);
    expect(LITE_PRIORITY_RANK.STAFF).toBeLessThan(LITE_PRIORITY_RANK.P1);
    expect(LITE_PRIORITY_RANK.P1).toBeLessThan(LITE_PRIORITY_RANK.P2);
  });
});
