# Migration Summary — ETH Payment (LINK → ETH)

This document summarizes the migration of `example-frontend` from the **LINK-funded**
aggregator to the **ETH-funded** `ReputationAggregator`. Arbiters are now paid in ETH; the
client no longer touches LINK (no token approval, no allowance management).

> Supersedes the previous "Enhanced LINK Token Management" summary. The LINK allowance
> system described there (`topUpLinkAllowance`, on-chain `Approval` event scanning, 0.5–2
> LINK reserves) has been **removed** — it is no longer how the app pays for evaluations.

## New deployed aggregators (ETH)

| Network | Address |
|---|---|
| Base Mainnet | `0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a` |
| Base Sepolia | `0xe8a385E473EA710c5a88Cc72681a16a26fe380e4` |

Same ReputationKeeper and operator/oracle contracts as before; only the aggregator's
payment rail changed.

## How payment works now

- `requestAIEvaluationWithApproval(...)` is **`payable`**. The requester prepays the
  worst-case cost in `msg.value` (and/or from existing on-chain credit). No LINK approval.
- Worst case = `maxTotalFee(maxFee)` = `effFee * (K + B*P)`. With the live params
  (K=6, M=4, N=3, P=2, B=3) and a 0.0001 ETH fee, that is `0.0001 * 12 = 0.0012 ETH`.
- The per-oracle fee is clamped on-chain to `maxOracleFee` (0.0004 ETH ceiling).
- Unspent prepay is **refunded as a pull-payment credit** (`ethOwed`), not auto-returned.
  It is auto-applied to the caller's next request, or withdrawn via `withdrawEth()`.

## Files changed

### Code
- **`client/src/utils/contractUtils.js`** — ABI updated: `requestAIEvaluationWithApproval`
  marked `payable`; added `maxOracleFee`, `ethOwed`, `withdrawEth`, `isFailed`. Removed the
  dead LINK-balance `checkContractFunding()`.
- **`client/src/pages/RunQuery.js`** — removed `topUpLinkAllowance()` and the LINK ABI
  import. New `computeEthFunding()` sizes `value = max(0, maxTotalFee − ethOwed)` and
  attaches it to the request; ETH-balance pre-flight; ETH custom-error messages
  (`InsufficientPayment`, `InactiveOracle`/`BadSelectionCount`). Added a **prepay-credit
  widget** (shows worst-case prepay + your `ethOwed` credit, with a "Withdraw credit"
  button and auto-reuse messaging).
- **`client/src/App.js`** — `MAX_FEE` set to `0.0001 ETH` (typical arbiter fee, under the
  0.0004 ETH ceiling). Also fixed network↔contract selection so switching networks
  re-selects a valid contract instead of stranding a wrong-network address.
- **`client/src/utils/contractDebugger.js`** and **`client/debug-contract.js`** — rewritten
  for ETH (ETH balance + `ethOwed` credit + worst-case prepay vs. balance + payable
  dry-run); dropped all LINK allowance/balance probing.
- **Removed** `client/src/utils/LINKTokenABI.json` (no longer used).

### Config / data
- `server/data/contracts.json`, `client/.env`, `client/.env.example`, and the fallback in
  `server/utils/contractsManager.js` updated to the new ETH aggregator addresses.

### Ops
- Added `rebuildAndRestart.sh` (project root): rebuilds the static client bundle, then
  restarts the services. Because the site is served from `client/build` and CRA bakes code
  + `REACT_APP_*` in at build time, client changes require a rebuild **and** restart.

## Testing

- ✅ Production build passes (`client/buildClient.sh` / `npm run build`), warnings only.
- ✅ Verified on Base Sepolia: no LINK approval step; MetaMask prompts for an ETH value;
  results render; unused prepay appears as withdrawable `ethOwed` credit.
- The same network-agnostic bundle serves Base Mainnet when the network toggle is switched.
