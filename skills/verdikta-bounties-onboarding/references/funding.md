# Funding is separate from preview

Local discovery needs no funds, wallet or registration. Fund only after separately authorizing a real commission or submission.

Current bounties use ETH on the explicitly selected Base network: creator reward, transaction gas, and hunter oracle prepay. No LINK, token approval or swap is required.

Read `requiredPrepay(bountyId)` immediately before start. The preparation event budget is only an estimate. The funder receives unspent oracle prepay when resolution succeeds; RefundDeferred can require later recovery, and PaymentDeferred can require a recipient withdrawal.

The owner policy caps transaction value, execution gas and cumulative execution cost per process. Base L1 data fees are charged separately; maintain a reserve and do not describe the execution cap as an all-in chain fee guarantee. For ongoing autonomous operation use the hosted runtime's durable policy ledger rather than these single-run scripts.

To take funds out, the owner asks for a withdrawal. `withdraw_to_owner.js` sends ETH, or LINK left by the retired swap, to the owner address recorded at onboarding and nowhere else (see [owner withdrawals](security.md#owner-withdrawals)). ETH that the escrow pull ledger holds for the wallet first needs `recover_funds.js --withdraw`.
