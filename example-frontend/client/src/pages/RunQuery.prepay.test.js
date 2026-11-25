import { estimateMaxTotalFee, prepayLooksWrong } from './RunQuery';

const FEE = 10n ** 14n; // 0.0001 ETH
const SMALL = { K: 6, M: 5, N: 4, P: 3, timeout: 300 };

describe('prepayLooksWrong', () => {
  it('accepts the honest worst case and moderate config increases', () => {
    const est = estimateMaxTotalFee(FEE, 0n, false, SMALL);
    expect(prepayLooksWrong(est, FEE, 0n, false, SMALL)).toBe(false);
    expect(prepayLooksWrong(est / 2n, FEE, 0n, false, SMALL)).toBe(false);
    expect(prepayLooksWrong(2n * est, FEE, 0n, false, SMALL)).toBe(false);
  });
  it('refuses a contract that asks for more than twice the worst case', () => {
    const est = estimateMaxTotalFee(FEE, 0n, false, SMALL);
    expect(prepayLooksWrong(2n * est + 1n, FEE, 0n, false, SMALL)).toBe(true);
    expect(prepayLooksWrong(10n ** 18n, FEE, 0n, false, SMALL)).toBe(true);
  });
});
