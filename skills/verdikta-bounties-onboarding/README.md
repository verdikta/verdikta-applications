# Verdikta Bounties operator skill

This skill sets up an explicitly authorized low-balance wallet/API identity and executes reviewed bounty transactions on Base or Base Sepolia. It uses ETH for rewards, evaluation prepay and gas. For wallet-free planning use the separate `verdikta-discover` skill.

## Install and set up

Copy the complete skill directory from a reviewed revision. In `scripts/`, run `npm ci --ignore-scripts`, then run `node onboard.js` in a human-controlled terminal after owner approval. The wizard handles network selection, encrypted wallet setup, owner funding and API registration, and prints the command for a read-only job-list check. It does not store the wallet password; see [wallet password](references/onboarding.md#wallet-password).

A ClawHub install (`clawhub install verdikta-bounties-onboarding`) has the same skill files without the tests and the three repository-only maintainer tools, `compile-contracts.js`, `sync_contract_assets.js` and `sync_wager_assets.js`; set it up the same way. Work orders also need the `verdikta-discover` skill installed beside this one: a draft handoff (`approve_work_order.js`, or a creator config with `workOrderDraft`) and a submission to a work-order bounty (its description has the `Service: <template>` line). Plain bounties, other submissions and wagers run without it. Install it in a directory named exactly `verdikta-discover` (for example `clawhub install verdikta-discover` into the same skills directory), with `npm ci --ignore-scripts` run inside it. Install both from releases you reviewed: the 1.7.x, 1.8.x and 1.9.x releases of this skill pair with `verdikta-discover` 1.1.0. Without the sibling (no `verdikta-discover` directory, or one without its dependencies), a work-order step stops before any upload or transaction and says it needs `verdikta-discover`. Earlier releases loaded it for every submission, so a submission failed without it even for a plain bounty.

For the separate `wallet_init`, `funding_instructions`, `funding_check`, `bot_register` and `preflight` helpers, required environment variables and API endpoint table, see [operator setup](references/onboarding.md). Never put wallet secrets in chat, and never pass confirmation flags without approval of the specific action.

## Execute approved work

Read [SKILL.md](SKILL.md) and [commission configuration](references/commission.md) before creating, submitting, resolving or recovering funds. Every transaction needs the configured network and an owner-reviewed spending policy. Keep saved state files for recovery. A preview never authorizes funding.

Since 1.7.1 an agent that also runs `verdikta-discover` can commission a draft from the owner's chat approval line, `Approve <hash prefix>, payout <X> ETH, window <N>h`: `node approve_work_order.js` binds that exact draft and writes `approved.json` under `~/.config/verdikta-bounties/work-orders/<hash prefix>/`, then `node create_bounty.js --config <that approved.json> --yes` runs every creation check and signs within the spend policy. It needs an operator-reviewed `~/.config/verdikta-bounties/commission-defaults.json` for the class, jury and oracle settings. See [the SKILL.md section](SKILL.md#commission-a-verdikta-discover-draft-from-a-chat-approval) and [chat approval](references/commission.md#chat-approval-of-a-verdikta-discover-draft).

Bots installed before 1.6.0 must follow the [1.6.0 migration notes](references/migration-1.6.0.md): the wallet password is no longer stored in `.env`, and scripts refuse to run until `node onboard.js --migrate-password` has moved it to a secret store. Then follow the [1.5.0 notes](references/migration-1.5.0.md). The 1.7.x, 1.8.x and 1.9.x releases need no migration step.

## Mutual wagers

Since 1.9.0 the agent can bet with another wallet: a mutual wager is two directed bounties, each paying the other bettor if that bettor's side wins, on a game (the website's Mutual Wager template, settled on the final score) or on a YES/NO question about a value published for a stated date, such as an official close (its Question Wager template). `node wager.js` has six verbs, `propose`, `answer <N>`, `check <N>`, `status`, `claim` and `close`, the same in every agent runtime. Nothing is posted until you reply with the line it prints, `Approve wager <16-hex hash prefix>, stake <X> ETH, vs <opponent>, settle <ISO time>`, which names those exact terms; the bounty's deadline is the settlement deadline to the second. The terms and checks are the website's own code. Claims come from the final score (for a question, the answer, the published value and the time it is for) and two quoted sources, never from the agent's own words, and are submitted only after your `Approve claim <16-hex hash prefix>, bounty #<N>` line. See [the SKILL.md section](SKILL.md#mutual-wagers) and [mutual wagers](references/wagers.md).

## Withdraw to the owner

Onboarding records your withdrawal address (`OFFBOT_ADDRESS` in `~/.config/verdikta-bounties/.env`). Since 1.8.0, `node withdraw_to_owner.js --amount <ETH>` or `--all` sends the wallet's ETH there and nowhere else, and `--asset LINK` does the same for LINK left by the retired swap (withdraw LINK first: it needs ETH for gas). Run it in your own terminal, where it asks you to type YES, or ask your agent, which shows you a `--dry-run` first. To see or change the address, run `node onboard.js --set-owner` in your own terminal (Enter keeps it). Bots onboarded before 1.8.0 already recorded the address entered as the "sweep address"; check it before the first withdrawal. See [the SKILL.md section](SKILL.md#withdraw-to-the-owner) and [owner withdrawals](references/security.md#owner-withdrawals).

## Campaign claims: link this wallet to Zealy

Verdikta's Zealy campaigns credit the wallet that funds or submits on Base, and Zealy can only authenticate a wallet from a browser or WalletConnect wallet. If this skill's wallet does the work, link the same address to your Zealy account once:

1. Copy the encrypted keystore (`VERDIKTA_KEYSTORE_PATH`, by default `~/.config/verdikta-bounties/verdikta-wallet.json`) to the machine with your browser wallet. It stays encrypted; the password never leaves your secret store or password file.
2. MetaMask: Add account, Import account, select type "JSON File", choose the keystore and enter its password. The imported account shows this skill's address.
3. On Zealy, link that account as your wallet and claim the campaign quests with it. Linking and claiming only sign messages; the agent keeps sending transactions from the same key, so there is no nonce conflict.
4. Keep the balance low, as this skill already requires, and remove the imported account from the browser wallet after the campaign if you prefer.

Smart-account wallets (Coinbase Smart Wallet and other ERC-4337 accounts) cannot claim: the escrow records the smart account and Zealy cannot authenticate it. They can still deliver work that pays creators.

## Validate from a repository checkout

Install dependencies in `scripts/`, `../verdikta-discover/` and `../../example-bounty-program/onchain/`. `npm test` in `scripts/` compiles contracts using the secret-free config before checking ABI compatibility and mocked lifecycle tests. Compilation may download the pinned Solidity compiler on first use; no deployment credentials are loaded. Hosted CI runs the same setup.

## Campaign

October 14 to November 4, 2026: the Bring a Task, Build a Habit campaign pays Zealy USDC for first paid wins and first paid tasks on Base; the operator links the agent wallet on Zealy and claims there. Details and every verifier message: https://www.verdikta.org/bounties/support
