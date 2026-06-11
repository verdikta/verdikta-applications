/**
 * Regression tests for maxOracleFee / estimatedBaseCost unit normalization.
 *
 * Historically /submit/prepare expected decimal ETH while /submit/bundle expected
 * wei — same param name, different units, easy to cross-contaminate. parseFeeToWei
 * now accepts BOTH forms on every endpoint (dot = ETH, bare integer = wei) and
 * rejects implausible values, so units are interchangeable.
 */
const { ethers } = require('ethers');
const { parseFeeToWei } = require('../utils/validation');

describe('parseFeeToWei', () => {
  it('parses decimal-ETH strings to wei', () => {
    expect(parseFeeToWei('0.00002').toString()).toBe('20000000000000');
    expect(parseFeeToWei('0.0001').toString()).toBe('100000000000000');
  });

  it('parses integer-wei strings unchanged', () => {
    expect(parseFeeToWei('20000000000000').toString()).toBe('20000000000000');
    expect(parseFeeToWei('0').toString()).toBe('0');
  });

  it('treats both forms of the same fee identically (no cross-contamination)', () => {
    // The exact scenario from the report: the same logical fee, two endpoints, two units.
    const fromEth = parseFeeToWei('0.00002');   // what /submit/prepare used to take
    const fromWei = parseFeeToWei('20000000000000'); // what /submit/bundle used to take
    expect(fromEth).toBe(fromWei);
  });

  it('accepts numbers and bigints too', () => {
    expect(parseFeeToWei(20000000000000n).toString()).toBe('20000000000000');
    expect(parseFeeToWei(0.00002).toString()).toBe('20000000000000'); // JS number → "0.00002"
  });

  it('rejects exponent-notation strings (ambiguous) with a clear message', () => {
    expect(() => parseFeeToWei('2e13', 'maxOracleFee')).toThrow(/decimal-ETH|integer-wei/i);
  });

  it('rejects implausibly large values (likely a units mistake)', () => {
    // A wei amount mistakenly passed where ETH was meant used to explode via parseEther.
    // "1" ETH is far above the 0.0004 ETH ceiling → rejected.
    expect(() => parseFeeToWei('1.0', 'maxOracleFee')).toThrow(/implausibly high|mix up units/i);
    expect(() => parseFeeToWei('100000000000000000', 'maxOracleFee')).toThrow(/implausibly high/i); // 0.1 ETH in wei
  });

  it('rejects malformed input with an actionable message', () => {
    expect(() => parseFeeToWei('', 'maxOracleFee')).toThrow(/empty/i);
    expect(() => parseFeeToWei('abc', 'maxOracleFee')).toThrow(/decimal-ETH|integer-wei/i);
    expect(() => parseFeeToWei('0x10', 'maxOracleFee')).toThrow(/decimal-ETH|integer-wei/i);
  });

  it('keeps a legitimate near-ceiling fee (0.0004 ETH) in both units', () => {
    expect(parseFeeToWei('0.0004').toString()).toBe('400000000000000');
    expect(parseFeeToWei('400000000000000').toString()).toBe('400000000000000');
  });
});
