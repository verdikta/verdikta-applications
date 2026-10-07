# Oracle Adapter proposal (draft 3, 2026-10-01)

## Purpose

The Oracle Adapter lets a settlement contract read a price or a status value from an external data feed without trusting a single publisher. It sits between the contract and up to five independent feed operators, aggregates their answers, and returns one value with a confidence flag.

## Design

1. Each feed operator signs its answer with a registered key and posts it to the adapter within a 90-second window.
2. The adapter takes the median of the posted values. If fewer than three operators post inside the window, it returns the previous value with the flag `STALE`.
3. A value that differs from the previous one by more than 20% is returned with the flag `VOLATILE` and the contract may defer settlement for one window.
4. Operator keys are rotated by the adapter's owner key, which is a 2-of-3 multisig.

## Trust model

Operators are paid per answer. An operator whose answer differs from the median by more than 5% in three consecutive windows is suspended for 24 hours. There is no slashing in this version; suspension is the only penalty.

## Failure handling

If the adapter itself does not answer, the contract uses the last value for at most two windows, then halts settlement until an operator posts again. There is no alert path in this version.

## Rollout

Deploy with three operators on the test network for two weeks, then five operators on the main network. The owner multisig can pause the adapter at any time.
