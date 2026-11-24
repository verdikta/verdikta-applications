# BountyEscrow against the real v2 aggregator

The unit tests in `../test` run BountyEscrow against `MockVerdiktaAggregator`. This opt-in suite
runs it against the real v2 `ReputationAggregator`, `ReputationKeeper` and `JuryBeacons` from
verdikta-dispatcher, with arbiters driven through the dispatcher's `TestOperator`. It covers what
the mock does not model:

- the draw's real gas (about 2.0M with 6 arbiters, 3.7M with 12, 13.5M with 50, against the 2^24
  per-transaction cap);
- the auto-settle a new request runs on up to 2 overdue rounds;
- the P-closest clustering of the combined score;
- the real phase and deadline rules.

At every step it also checks that the lens's `nextAction` names a call that succeeds.

## Run

```
# verdikta-dispatcher checked out beside verdikta-applications, on its `beacon` branch
cd example-bounty-program/onchain
npm run test:integration
```

`prepare.js` copies this package's contracts and the dispatcher's
`reputationBasedAggregator/contracts` into `integration/.contracts/` (git-ignored) before
compiling. To use a dispatcher checkout somewhere else, set `VERDIKTA_DISPATCHER_DIR` to its
`reputationBasedAggregator` folder. The suite needs no secrets and no network.

## Reading the output

The `after` hook prints:

- the lens log;
- each scenario's results;
- the gas each step used, against `eth_estimateGas`;
- any lens mismatches.

The suite checks what the scenarios assert. Mismatches are logged, not failed.

On Hardhat the log shows a few `B+1` / `C+2` mismatches: the lens says `AWAIT_ORACLE` one block
before `drawJury` / `promote` would succeed. This is expected. A view call reads the latest block,
while a transaction lands in the next one. The lens uses the aggregator's own rule
(`block.number >= X + 2`), so it is late by one block, never early. Counting one block ahead would
send a reverting call on any node that answers view calls against the pending block.
