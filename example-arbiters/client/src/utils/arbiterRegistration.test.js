import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  parseFee, parseClasses, buildDescriptor, parseDescriptor, serializeDescriptor,
  exitView, formatDuration, reasonLines, DESCRIPTOR_VERSION, keeperForResume,
} from './arbiterRegistration';
import { arbiterKey } from '../services/arbiterContracts';

const OP = '0x21dF544947ba3E8b3c32561399E88B52Dc8b2823';
const JOB = '0x00000000000000000000000000000000000000000000000000000000000000a1';

describe('parseFee', () => {
  it('accepts a positive ETH amount', () => {
    expect(parseFee('0.0001')).toEqual({ wei: 10n ** 14n, display: '0.0001' });
  });
  it('rejects zero, junk and amounts over the keeper\'s uint64', () => {
    expect(parseFee('0').error).toMatch(/greater than 0/);
    expect(parseFee('abc').error).toMatch(/Invalid/);
    expect(parseFee('').error).toMatch(/Enter/);
    expect(parseFee('18.4').error).toBeUndefined();
    expect(parseFee('18.5').error).toMatch(/too large/);
  });
});

describe('parseClasses', () => {
  it('dedupes and bounds to 1..5', () => {
    expect(parseClasses('128, 129 128')).toEqual({ classes: [128, 129] });
    expect(parseClasses('1,2,3,4,5,6').error).toMatch(/At most 5/);
    expect(parseClasses('').error).toMatch(/at least one/);
  });
});

describe('descriptor', () => {
  const d = buildDescriptor({ network: 'base_sepolia', keeperAddress: OP, operator: OP, owner: OP, jobId: JOB, fee: '0.00002', classes: [128] });

  it('is version 2 and round-trips', () => {
    expect(d.version).toBe(DESCRIPTOR_VERSION);
    expect(DESCRIPTOR_VERSION).toBe(2);
    const back = parseDescriptor(serializeDescriptor(d));
    expect(back).toMatchObject({ operator: OP, jobId: JOB, fee: '0.00002', classes: [128], keeperAddress: OP, legacy: false });
  });

  it('accepts a v1 backup but drops its (v1) keeper address', () => {
    const v1 = { ...d, version: 1 };
    const back = parseDescriptor(JSON.stringify(v1));
    expect(back.legacy).toBe(true);
    expect(back.keeperAddress).toBeNull();
    expect(back.classes).toEqual([128]);
  });

  it('refuses a newer version and bad fields', () => {
    expect(() => parseDescriptor(JSON.stringify({ ...d, version: 3 }))).toThrow(/newer/);
    expect(() => parseDescriptor(JSON.stringify({ ...d, jobId: '0x12' }))).toThrow(/jobId/);
    expect(() => parseDescriptor('{')).toThrow(/valid JSON/);
  });
});

describe('exitView', () => {
  const now = 1_800_000_000;
  it('is none for an arbiter that is not exiting', () => {
    expect(exitView({ flags: 1, exitAt: 0 }, now).state).toBe('none');
  });
  it('counts down the unbonding, then waits out a block, then is ready', () => {
    const job = { flags: 1 | 8, exitAt: now + 3600, blockedUntil: 0 };
    expect(exitView(job, now)).toEqual({ state: 'unbonding', waitSeconds: 3600 });
    expect(exitView({ ...job, blockedUntil: now + 7200 }, now + 3600)).toEqual({ state: 'blocked', waitSeconds: 3600 });
    expect(exitView(job, now + 3600)).toEqual({ state: 'ready', waitSeconds: 0 });
  });
});

describe('formatDuration / reasonLines', () => {
  it('formats compactly', () => {
    expect(formatDuration(172800)).toBe('2 d');
    expect(formatDuration(90000)).toBe('1 d 1 h');
    expect(formatDuration(3700)).toBe('1 h 1 min');
    expect(formatDuration(59)).toBe('59 s');
  });
  it('explains the re-sync freeze', () => {
    const lines = reasonLines(['resyncing', 'new', 'nonsense']);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/re-sync/);
  });
});

describe('arbiterKey', () => {
  it('matches the keeper\'s keyOf: keccak256(abi.encodePacked(oracle, jobId))', () => {
    const packed = ethers.concat([OP, JOB]);
    expect(arbiterKey(OP, JOB)).toBe(ethers.keccak256(packed));
    // value read from the v2 keeper on a local node for this (oracle, jobId)
    expect(arbiterKey(OP, JOB)).toBe('0x806802346f2a1046a24eeef0f819fffe8ca052ce96ee5d283484cd0a4457c8a0');
  });
});

describe('keeperForResume', () => {
  const LIVE = '0x1111111111111111111111111111111111111111';
  const OLD = '0x2222222222222222222222222222222222222222';
  it('uses the live keeper over a stored (possibly redeployed) one', () => {
    expect(keeperForResume(LIVE, OLD)).toBe(LIVE);
  });
  it('falls back to the stored keeper only while the live one is unknown', () => {
    expect(keeperForResume(undefined, OLD)).toBe(OLD);
    expect(keeperForResume(null, 'junk')).toBe(null);
  });
});
