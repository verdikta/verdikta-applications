import { describe, it, expect, beforeEach } from 'vitest';
import {
  markExitRequested, markExitCompleted, updatePlannedParams, clearPendingReset, getPendingReset, getPendingResets,
} from './resetRegistry';

// Minimal localStorage for the node test environment.
beforeEach(() => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
});

const base = {
  network: 'base_sepolia', owner: '0xAbC0000000000000000000000000000000000001', keeperAddress: '0xkeeper',
  oracle: '0xOp00000000000000000000000000000000000002', jobId: '0xJOB', fee: '0.0001', classes: [128],
};

describe('resetRegistry (exit, then register again later)', () => {
  it('records the plan at requestExit and walks it to exited', () => {
    markExitRequested({ ...base, exitAt: 123 });
    expect(getPendingReset('base_sepolia', base.oracle.toLowerCase(), '0xjob')).toMatchObject({ stage: 'exiting', exitAt: 123, classes: [128] });
    updatePlannedParams({ ...base, classes: [128, 129] });
    markExitCompleted({ ...base, fee: null, classes: null });
    const e = getPendingReset('base_sepolia', base.oracle, base.jobId);
    expect(e.stage).toBe('exited');
    expect(e.classes).toEqual([128, 129]); // a null edit keeps the planned params
  });

  it('lists per network + owner, case-insensitively, and clears', () => {
    markExitRequested({ ...base, exitAt: 1 });
    markExitRequested({ ...base, network: 'base', exitAt: 1 });
    expect(getPendingResets('base_sepolia', base.owner.toLowerCase())).toHaveLength(1);
    expect(getPendingResets('base_sepolia', null)).toEqual([]);
    clearPendingReset(base);
    expect(getPendingResets('base_sepolia', base.owner)).toHaveLength(0);
    expect(getPendingResets('base', base.owner)).toHaveLength(1);
  });

  it('creates an exited entry if the exit was requested elsewhere', () => {
    markExitCompleted(base);
    expect(getPendingReset(base.network, base.oracle, base.jobId)).toMatchObject({ stage: 'exited', fee: '0.0001' });
  });
});
