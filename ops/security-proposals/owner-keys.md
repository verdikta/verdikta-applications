# PROPOSAL: the contract owner keys (round-2 security review, compromise direction)

Status: a proposal for the owner. Nothing here is deployed or changed in a contract.

## Where the power sits

BountyEscrow has no owner, and its aggregator is an immutable. StakeAttestation's owner can only change
fees for future listings: `fund()` takes `expectedFeeWei`, so a fee change cannot be front-run, and a
listing's floor and confirm size are copied when it is listed. Neither contract can be drained by its
own admin.

Both contracts, though, pay whatever verdict the aggregator reports. The aggregator gets its jury from
two contracts that its owner can replace at any time, and the keeper's owner can choose that jury. So
the effective admin of every bounty and every stake is the owner of the **aggregator** and of the
**keeper**. Today that owner is the deployer EOA. The deploy scripts call `Ownable(msg.sender)` and never
`transferOwnership`, and the deployer is `PRIVATE_KEY` from `/root/verdikta/secrets/.env.secrets`
(`dispatcher/reputationBasedAggregator/hardhat.config.js`). Until this patch, the production bounty and
arbiters web servers loaded that whole file into `process.env`; `utils/loadSecrets.js` now drops it.

| Key | Takes over in | What it can do | Bound on loss |
|---|---|---|---|
| Aggregator owner | 1 tx: `setContracts(evilKeeper, evilBeacons)` | Every round drawn after that tx gets the jury the attacker's keeper returns, and the commit payments go to `payees` that its beacons choose. Every open bounty pays the attacker's submission, and every claim against a stake succeeds. | Every bounty's escrow, every listing's stake, and the fees of every round drawn later. Rounds already past their draw keep their jury. |
| Keeper owner | 3 txs, measured (dispatcher `test/breach.owner-powers.test.js`): `setPenalties(1,0,true)`, `setRoles(eoa, ROLE_SCORE)`, `applyOutcomes(all keys, MISS_FAILED)` | Burns 100% of every arbiter's stake (the VDKA is destroyed, not taken) and bans every key. The attacker then registers its own arbiters, and with repeats allowed, one key fills every jury. After that the losses are the same as for the aggregator owner. | All staked VDKA, plus everything in the aggregator row. |
| JuryBeacons owner | 1 tx | `setParams` (quorum and timeout for new requests) and `setApproved`. This affects the draw's liveness and entropy, not who can be drawn. | The availability of the beacon stage. |
| StakeAttestation owner | 1 tx | Fees for future listings, the fee recipient, and the floor and confirm size of future listings. | Future listing fees only. |
| BountyEscrow | none | | |
| `KEEPER_PRIVATE_KEY` (bounty server) | | Only permissionless calls: `drawJury`, `closeCommits`, `promote`, `closeFailedRound`, `withdrawEth`. | The wallet's ETH and its unwithdrawn rewards. |

Detection today: none. No monitor watches `OwnershipTransferred`, `RolesSet`, `ContractApproval`, or the
aggregator's `setContracts`, which emits no event.

## Ranked by value per effort

1. **Move the deployer and owner keys off the web host.** This costs nothing in gas. Keep
   `PRIVATE_KEY*` out of `/root/verdikta/secrets/.env.secrets`, in a hardware wallet or at least in
   another file that no service reads. This patch already stops the two servers from loading them.
   To check: `grep -c '^PRIVATE_KEY' /root/verdikta/secrets/.env.secrets` (run it yourself, as the review does not read the file).
2. **Transfer ownership to a Safe** (2-of-3, signers on separate devices) of the aggregator, keeper,
   JuryBeacons and StakeAttestation. Use `transferOwnership`; StakeAttestation is `Ownable2Step`, so
   the Safe accepts. This costs 4 txs and needs no redeploy.
3. **Put a TimelockController in front of the Safe** (min delay 48 h, the Safe as proposer and
   canceller, executor open), and make the Timelock the owner. 48 h is under the keeper's 2-day
   minimum unbonding, so an arbiter that sees a hostile `setPenalties` queued cannot get out in time.
   Either raise `MIN_UNBONDING` above the delay at the next keeper deploy, or set the delay to 24 h and
   keep unbonding at 2 days or more. `pause()` should stay instant: keep a guardian role, which is the
   Safe directly, for `pause` only.
4. **Remove or narrow these owner powers at the next deploy:**
   - Aggregator `setContracts`: make the keeper immutable, or let it change only through the
     timelock and emit an event. Today it emits none.
   - Keeper `setRoles` and `setApproved` to an EOA: allow ROLE_SCORE and ROLE_SELECT only for contract
     accounts (`code.length > 0`), and emit the role change (already done) to a monitor.
   - Keeper `setPenalties`: cap `burnPerBlock` and require `maxOffenses >= 3`. The owner's
     decision is a ban after three; a cap at the contract stops a one-tx mass burn.
   - `burnOnBan`: make it immutable at deploy if it is meant to stay off.
5. **Monitor these events** (a free Tenderly or OpenZeppelin Defender alert, or a 20-line script on
   the arbiters server's existing RPC poller): `OwnershipTransferred`, `RolesSet`, `ContractApproval`,
   `Approval` (beacons), every owner setter, and a change in `aggregator.keeper()` or
   `aggregator.beacons()`, polled every block.

## Recovery

If an owner key is lost or leaked today: call `pause()` on the aggregator, then transfer ownership
to a fresh key, racing the attacker. Do this in a pre-signed bundle if possible. Rounds already drawn
keep their jury, and nothing returns a burned stake. With items 2 to 5 in place, a leaked single
key cannot act, and a queued hostile call shows up 48 h before it can execute.
