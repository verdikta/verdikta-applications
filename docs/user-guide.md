# Verdikta User's Guide: AI-Powered Evaluations for Smart Contracts

**Version Beta-1**

!!! info "What this guide was checked against"
    Revised on 2026-11-24 for the **v2** aggregator: the `ReputationAggregator`, `ReputationKeeper` and `JuryBeacons` contracts on the `beacon` branch of [verdikta-dispatcher](https://github.com/verdikta/verdikta-dispatcher/tree/beacon/reputationBasedAggregator/contracts). One aggregator serves every jury size: each request carries its own jury, and the four sizes below are the bounty program's presets. The v2 aggregator is **not deployed yet**, so this guide gives no address: the examples use the placeholder `<V2_AGGREGATOR_ADDRESS>`, to be replaced once it is deployed. The v1 aggregator still running on Base works differently (one transaction per request, a fixed timeout) and is not covered here. Fees are paid in ETH. The numbers in this guide are the defaults in the v2 source, settings that the contracts' owner can change: each one is given with the contract function that returns the current value, so you can check it yourself after the deployment.

## Introduction

Verdikta brings trustless AI to blockchain applications. It enables smart contracts and decentralized applications (dApps) to request AI evaluations (for example, for dispute resolutions or content analysis) that are decided collectively by multiple random AI agents called "arbiters" that are incentivized for accuracy. Using Verdikta, developers can integrate complex AI reasoning into on-chain logic without relying on a centralized service. This guide walks you through the concepts and steps to use Verdikta, from understanding the underlying technologies to the process of requesting and retrieving results. We'll cover the basics of smart contracts, Chainlink oracles, and IPFS, explain how Verdikta works, and give code examples in Solidity and JavaScript to help you get started.

## Background Concepts

Before diving into Verdikta details, it's important to understand its underlying technologies: smart contracts, Chainlink oracles, and IPFS. If you're already familiar with these, feel free to skip ahead. For those less familiar, here is a brief overview.

### Smart Contracts

Smart contracts are self-executing programs that run on a blockchain. They enforce rules and agreements in code without manual oversight. Once deployed, a smart contract's code is tamper-proof and transparent: it always executes as written when its functions are called. This enables trustless execution of transactions—such as holding funds in escrow and releasing them based on predefined conditions. However, by default smart contracts only have access to on-chain data. They cannot directly access external information (like web API data or AI computations) on their own. This is where oracles come in.

### Chainlink Oracles and Decentralized Trust

Oracles bring external information into the blockchain. Chainlink is a well-known decentralized oracle network that connects smart contracts to off-chain data and computation. Oracles act as bridges, feeding the external information into the blockchain in a secure and reliable way. A Chainlink oracle network consists of many independent node operators that fetch or compute data and reach consensus on the result, which is then delivered on-chain for use by smart contracts. This decentralized design is crucial because having to trust a single oracle operator, what in Verdikta is called an *arbiter*, would undermine the trustless nature of smart contracts. In this document, "trustless" means not having to trust a single entity.

For example, Chainlink Data Feeds can aggregate price data from many sources to provide tamper-resistant price oracles in DeFi. Similarly, Chainlink can be used to connect AI models to smart contracts. Rather than trusting a single AI API, an oracle network can call multiple AI models or services and aggregate their responses. This increases reliability: if one model is wrong or biased, the others can outvote it. Verdikta leverages this principle by having multiple AI arbiters evaluate each query using multiple AI algorithms and intelligently combining all the results.

### IPFS

IPFS (InterPlanetary File System) is a decentralized file storage and sharing network. It allows data (like documents, images, or JSON blobs) to be stored broadly and referenced by a unique cryptographic hash, called a CID (standing for Content Identifier). Unlike a traditional URL that points to a location on a specific server, a CID is a signature that points to content itself, which can be stored anywhere, or in multiple places. So, IPFS provides a content-addressable, peer-to-peer method for storing and sharing data. In practice, this means if you have some data (for example, a text description of a dispute or a query for an AI model), you can add it to IPFS and share only its CID. Then anyone with that CID can retrieve the data from the IPFS network knowing it is unchanged because if the content were changed in any way it would give a different CID.

Verdikta uses IPFS to handle the often large amounts of data associated with AI evaluations. Instead of putting a whole essay or case description on the blockchain (which would be expensive and impractical), the user provides a comparatively short (100 or fewer characters) CID pointing to the data on IPFS. The arbiters fetch the content from IPFS off-chain, evaluate it with AI, and then similarly store any detailed justifications or responses back to IPFS. The smart contract only needs to handle CIDs. Using IPFS in this way keeps Verdikta's on-chain footprint small while maintaining decentralization (the data isn't reliant on a single server) and integrity (information is addressed by its content, so everyone can be sure of getting the correct data).

## Trustless AI for Smart Contracts

Trustless AI refers to the ability to incorporate AI-driven decisions without having to trust a single AI provider. The goal is to get on-chain AI results that are accurate and manipulation-resistant. This is a new frontier because leading AI models are typically run on centralized servers. Verdikta's approach is to decentralize the evaluation process: multiple independent AI agents (the arbiters) evaluate a query, with the results combined on-chain in a smart contract called the Aggregator using rules that incentivize honesty and accuracy. In addition to a base fee paid to all participating arbiters, bonuses are paid to the arbiters that respond quickly and accurately, as determined by clustering results. A separate special smart contract, the Reputation Keeper, maintains timing and quality reputation scores for the arbiters and uses these to increase the chances of selection for future queries. The organization of the Verdikta system is illustrated in the figure below.

![Verdikta System Architecture](images/media/image1.png)

The benefits of this approach include the following:

- **Reliability and Accuracy:** By aggregating outputs from multiple AI models and instances, which different entities can operate on different platforms, Verdikta reduces the risk of failure and inaccuracy. The arbiter network consensus approach means the final result represents broader agreement. The system "crowd-verifies" the answer.

- **No Single Trusted Party:** Users do not have to trust any one person or entity. The arbiters are decentralized and chosen at random for each query, and their outputs are combined in a smart contract. Even if one arbiter is malicious or faulty, it will be outweighed by others.

- **Verifiability:** The code and output for the smart contracts is public, and anyone can verify that the process (random selection, funds commitment, response validity, scoring) was followed correctly. While the AI reasoning process is off-chain, multiple random nodes agreeing on the output provides validation.

- **Incentive Alignment:** Verdikta incorporates a reputation and staking system (discussed in detail later in this document) to economically motivate honest behavior. The AI arbiters are held accountable for the quality of their outputs via reputation scores and penalties and rewards. Incentives—where providers are rewarded or penalized based on the quality of their data—are vital for a trustless system.

In summary, Verdikta's trustless AI mechanism allows smart contracts to confidently use AI-generated decisions (like "Who wins this dispute?" or "Is this content acceptable?") knowing that the answer was derived in a decentralized, tamper-resistant way. With these concepts in mind, let's next look at how Verdikta itself is structured and how to use it.

## The Verdikta System 

Verdikta uses multiple logical components. On-chain there is the Aggregator's combinatorial logic and the Reputation Keeper's staking and reputation-management mechanism for arbiters. Off-chain, there are many instances of software—variously owned and operated—that perform the actual AI computations. Let's break down the roles and the flow of an evaluation request.

### Components

- **User (Requester):** This is you (or your smart contract) requesting an AI evaluation. For example, you might be developing a dApp that needs an AI to score a piece of content or resolve a dispute between two parties. Typically, the user formulates the query and stores it on IPFS before calling the Verdikta contract to start an evaluation.

- **Aggregator Contract:** This is the core Verdikta smart contract deployed on-chain. It coordinates the process. Its responsibilities include the following: receiving and escrowing evaluation requests, drawing a jury of arbiters for each request, collecting their responses through a commit-reveal process, aggregating the results (e.g. computing an average score), and reporting each arbiter's performance to the Reputation Keeper. You interact directly with this contract to request evaluations, to move your request through its steps, and to fetch results. One deployment serves every jury size: each request says how many arbiters to draw, promote, count and cluster, and how long the round may run (see the table under the lifecycle below).

- **Reputation Keeper Contract:** The Aggregator contract relies on a separate Reputation Keeper contract to do its job. This smart contract executes the Stake and Reputation System. Each arbiter has skin in the game. Arbiters stake Verdikta tokens to register with the Reputation Keeper (100 tokens per arbiter by default, `stakeRequirement()`). An arbiter whose score falls to zero is blocked from selection for a time, and repeated blocks end in a permanent ban; the contract can also burn part of the stake, an amount that is zero by default (see [Reputation Tracking](#reputation-tracking)). The reputation scores measure past performance. If an arbiter answers on time and close to the other arbiters, its reputation scores go up; if an arbiter deviates or fails to respond, its reputation scores go down. The Reputation Keeper also sends arbiters short "health calls" that each must answer within 60 seconds; an arbiter that does not is frozen (left out of selection) until it answers. The Reputation Keeper uses timeliness and quality ratings for each arbiter to decide eligibility to participate and to determine likelihood of selection in queries. The use of staking and reputation scoring creates an incentive structure where arbiters are motivated to provide truthful, high-quality answers.

- **AI Arbiters:** These are Verdikta logical nodes (Chainlink nodes working with other software) running AI models. Each arbiter is uniquely identified by a combination of 1) an operator smart contract address and 2) a Chainlink Job ID. An operator registers this identifier pair with the Verdikta network by staking Verdikta tokens (`registerArbiter` on the Reputation Keeper). Arbiters each have two reputation scores that are tracked. One is for timeliness and the other is for quality. When a new request comes in, a jury is drawn at random from the registered arbiters, with a seed that nobody knows when the request is sent: the hash of the block after the request, optionally mixed with values revealed by "beacon" arbiters (see the lifecycle below). Each selected arbiter retrieves relevant query data from an IPFS node (using the CID provided), runs AI models to evaluate it, and produces an output in the form of numerical scores (the decision) and a textual justification explaining the reasoning. The justification is uploaded to IPFS by the arbiter, yielding a content-hash CID for conveying the explanation text. The arbiter submits its score and the justification CID back to the ReputationAggregator contract as its answer.

- **Verdikta Payment:** Verdikta's services are not free—users must pay in cryptocurrency for each AI evaluation request. This fee rewards the arbiters and compensates for their costs (e.g., compute, blockchain access, AI access, and data storage/retrieval). The fee is paid in ETH, the native currency of Base. You send the ETH with the call to `requestAIEvaluationWithApproval()`: the amount is a worst-case budget that the contract's `maxTotalFee()` function returns, and whatever a round does not spend is normally credited back to you (the exceptions, where it goes to the protocol's treasury instead, are listed under [Failure and Refund Paths](#failure-and-refund-paths)). The function keeps its historical name, but there is no token approval and you need no LINK: Chainlink is still how requests reach the arbiters, and those requests carry no LINK payment. We will see how to handle this in the usage section.

### How an Evaluation Request Works (Lifecycle)

Here is a step-by-step outline of what happens when you request an AI evaluation on Verdikta:

1. **Query Preparation:** The user prepares the query data and stores it on IPFS, obtaining a content hash, the CID. The query takes the form of comma-delimited CIDs followed by optional colon-delimited text. Here is the pattern: `CID1,CID2,…,CIDN:TEXT`.

2. **Query CID Details:** The first CID in the query represents data in the following form: It is a zipped directory holding files, one of which is named `manifest.json`. This JSON manifest file holds 1) a version number, 2) a name for the primary file describing the query, 3) jury parameters including which AI models to query and how to weight them, and 4) a list of supporting files. Additional CIDs can hold additional supporting files. Often just one CID will be used, while the optional use of multiple CIDs allows data to originate at different times and from different sources, which is useful for some applications.

3. **Request Submission (On-Chain):** The user calls the Aggregator contract's function `requestAIEvaluationWithApproval()` to initiate the request. This call sends the CIDs and the optional text field, the jury the request wants (*K*, *M*, *N*, *P* and the round timeout, see [Jury Size](#jury-size)), and the same transaction carries the ETH that pays for the evaluation (see the coding section for how to size it). The request only records the query and escrows the ETH, in block *B*; no arbiter is chosen or paid yet. The contract emits a `RequestAIEvaluation` event with the request's aggregation ID (`aggId`), which you need for every later step. Aggregation IDs are sequential: the first request to a deployment gets `bytes32(1)`, the next `bytes32(2)`, and so on.

4. **Use of Multiple AI Engines:** With Verdikta, any number of AI types can be requested with any number of calls made to each. The ability to interact with a particular AI model type is determined by the arbiter's 64-bit *class*, with some classes able to use frontier models from, for example, OpenAI and Anthropic, while others are able to run open source models. Some arbiters can handle multiple classes. A request names one class, and the models listed in its manifest should come from that class's pool; the pools are listed in the [ClassID usage guide](https://docs.verdikta.org/verdikta-common/CLASSID_USAGE_GUIDE/). Every arbiter selected for a request is asked to run the same models, the ones the manifest names.

5. **Jury Draw (Random & Trustless):** From block *B*+2 on, anyone can call `drawJury(aggId)`. The draw uses the seed `keccak256(aggId, blockhash(B+1))` and the Reputation Keeper's state as it was in block *B*, so nobody can predict the jury when the request is signed, and who draws, or when, does not change it. The keeper selects the request's *K* arbiters from the pool of staked arbiters that support the requested class, giving higher-weighted chances to those with better reputations (see [Random Selection of Arbiters](#random-selection-of-arbiters)), and the aggregator sends each the query. Each selected arbiter's owner is credited its base fee at this moment. The draw pays a reward of twice your fee ceiling: to you, if you draw within 30 seconds (`requesterDrawPriority()`); after that, to whoever draws. Draw promptly: the seed must be stored within about 27 minutes (8,191 blocks; `drawJury` or `sealSeed(aggId)` stores it), and no draw is possible more than a day after the request. A round that misses either limit can only be cancelled, and its prepayment goes to the treasury (see [Failure and Refund Paths](#failure-and-refund-paths)).

    **Beacons (optional).** A request may set the `withBeacons` flag (the bounty program's largest jury size does). The first `drawJury` then starts a beacon stage instead: the keeper picks 4 arbiters of the class, each reveals its next hash-chain value, and once the first 2 values are in (within 120 seconds), a second `drawJury` draws the jury with those values mixed into the seed. The 2 beacons whose values are used are each paid one fee. Beacons make the seed independent of the block producer as well.

6. **Commit-Reveal Process:** The aggregator works with the jury in two steps. First the *K* drawn arbiters process the query with AI but do not return the result. Instead each sends a commitment: a hash of its result combined with a random 128-bit salt and bound to the round:
   ```solidity
   bytes32 hash = keccak256(abi.encode(aggId, operatorAddress, response, salt))
   ```
   The commit phase closes as soon as *M*+ commits are in (*M*+ = *M* + ⌈(*K* − *M*)/2⌉), or, once *T*+ seconds (155 by default, `tPlus()`) have passed since the draw, with any commit that brings the count to at least *M*. If no commit arrives after *T*+, anyone may close the phase with `closeCommits(aggId)`. From two blocks after the close, anyone may call `promote(aggId)`, which picks *M* of the committed arbiters at random (from the hash of the block after the close, so the arbiter that closed the phase cannot predict it) and asks them to reveal. The caller of `promote` earns one fee at your ceiling. Promoted arbiters always get at least 120 seconds (`revealWindow()`) to reveal. This two-step process prevents a rogue arbiter from just copying the answer of another arbiter.

7. **Off-Chain Evaluation:** Each selected arbiter has software running on Internet-connected hardware. This software sees that it has been picked for processing with a given query package. Content is downloaded from IPFS using the provided CIDs (Always guaranteed through IPFS to yield the correct, untampered data). The arbiter software runs the AI evaluation and produces a set of scores for the multiple options in the query, or a single number if the query asks for one. It also produces a textual justification. The arbiter then stores this justification using IPFS, getting an IPFS CID to return in the results response.

8. **Submission of Results:** Each arbiter submits its evaluation back to the aggregator contract by calling a Chainlink operator callback that uses the `fulfill()` function. This includes the numeric scores and the CID of the justification.

9. **Aggregation of Results:** When the *N*-th promoted arbiter reveals, the contract aggregates the *N* counted reveals in the same transaction. It picks a cluster of *P* answers: for one-number answers, the *P* consecutive values with the smallest spread; for longer answers, the tightest group of an answer and its *P* − 1 nearest neighbours. The cluster's average is the result. Answers outside the cluster do not contribute to the final result. A promoted arbiter may still reveal after aggregation, until the round's deadline: its answer does not change the result, but it is scored, so it is not counted as missing.

10. **Finalize and Store Outcome:** The Aggregator contract stores the averaged scores and the clustered arbiters' justification CIDs on-chain under the aggregation ID, and emits `FulfillAIEvaluation` (with the aggregation ID, final scores, and justification CIDs). From this point `getEvaluation(aggId)` returns the result.

11. **Payouts:** Every arbiter in the jury was credited its base fee at the draw. The clustered arbiters receive a bonus on top (a multiple, 3X by default, `bonusMultiplier()`, of their fee) when the result is aggregated. Payments are credits in the contract's ledger (`ethOwed`), which each arbiter's owner collects with `withdrawEth()`. Whatever is left of your prepayment is credited to you in the same ledger at that moment: you can withdraw it or let it pay for your next request.

12. **Settlement and Reputation:** Each round has a deadline: the request's timeout after the draw, extended if the commit phase closed late or `promote` came late, so that promoted arbiters still get their reveal time. After the deadline, `settle(aggId)` reports every juror's outcome to the Reputation Keeper, which updates the scores (see [Reputation Tracking](#reputation-tracking)). Anyone may call `settle`, and every new request first settles due rounds, in queue order, until `settlePerRequest()` (2) × its own *K* jury slots are spent, so settlement does not depend on an outside service. The last round settled may overshoot that budget by at most its own *K*, so the first due round is always settled, whatever its size. A round not yet past its deadline stops the walk: rounds behind a long-timeout round wait for it, or for anyone's `settle`. Until a round is settled only its scores and penalties (and, for a failed round, its refund) wait, since a result is readable from aggregation; an arbiter that completes its exit first escapes them. `settlePerRequest = 0` turns settlement by requests off. A round that never produced a result is closed as failed by the same call; see [Failure and Refund Paths](#failure-and-refund-paths).

13. **Result Available to User:** The user (or any interested party) can retrieve the outcome as soon as the `FulfillAIEvaluation` event is emitted, before settlement. The user's original contract (if they used one to call Verdikta) can read it with `getEvaluation(aggId)`, and each juror's own score with `getOutcomeScores(aggId, outcome)` (see [Reading Results On-Chain](#reading-results-on-chain)).

All of this happens in a trustless way: nobody chooses the jury, nobody is trusted individually, and after some time (depending on how long the off-chain AI takes) the result is on chain. Multiple incentivized independent arbiters and cryptographic randomness gave integrity to the process. Unlike v1, a v2 request needs a few more transactions after the request itself: the draw (twice with beacons), and when nobody else sends them, `closeCommits` and `promote`. Anyone may send each of them, and the draw and promote calls pay their caller, so third parties have a reason to. The v2 contracts have not run on a public network yet, so there is no latency measurement for them; the deadlines below bound how long a round can take.

You can follow a round with `getRoundInfo(aggId)`, which returns its phase and its timing:

| **Phase** | **Meaning** | **What moves it on** |
|-----------|-------------|----------------------|
| 1 | Escrowed, awaiting the jury draw | `drawJury(aggId)`, from block *B*+2 |
| 2 | Beacon stage (beacon requests only) | a second `drawJury(aggId)` once 2 beacon values are in, or after the 120 s beacon deadline |
| 3 | Commit phase | commits; `closeCommits(aggId)` after *T*+ with at least *M* commits |
| 4 | Commit phase closed, awaiting promotion | `promote(aggId)`, from two blocks after the close |
| 5 | Reveal phase | reveals; the *N*-th one aggregates |
| 6 | Result available, awaiting settlement | `settle(aggId)` after the deadline |
| 7 | Settled | — |
| 8 | Failed (and settled) | — |
| 9 | Cancelled: never drawn, prepayment sent to the treasury | — |

`getRoundInfo` also returns the request block and time, the stored seed hash, the block at which the commit phase closed, the ETH received and what was credited from it (base fees, bonuses, rewards), the `deadline` (0 until the draw), the end of the *T*+ window (`windowEnd`: 0 until the draw, then the draw time plus the *T*+ in force at the request) and the number of commits. A round keeps the *T*+ of its request, so a later `setLimits` cannot move its commit window.

### Jury Size

One aggregator serves every jury size: the jury is part of each request, as its last argument, `Jury {K, M, N, P, timeout}` (in Solidity a struct of four `uint8` and a `uint40`; in ethers an object or array). `getJury(aggId)` returns the jury a round was requested with. The aggregator has no jury size of its own. The four sizes the bounty program uses (its class presets) are:

| **Jury** | **Small** | **Medium** | **Large** | **Jumbo** |
|----------|-----------|------------|-----------|-----------|
| Arbiters drawn (*K*) | 6 | 8 | 21 | 50 |
| Committers promoted to reveal (*M*) | 5 | 5 | 16 | 38 |
| Reveals aggregated (*N*) | 4 | 4 | 13 | 27 |
| Cluster size (*P*) | 3 | 3 | 10 | 17 |
| Seconds from the draw to the deadline (`timeout`) | 300 | 300 | 300 | 600 |
| Beacons (`withBeacons`) | off | off | off | on |

You may ask for any other jury that keeps to the rules. A request reverts with `BadJury` unless:

- *K* ≥ *M* ≥ *N* ≥ *P* ≥ 1;
- *N* ≤ 40 (the *N*-th reveal pays for clustering all *N*);
- *P* ≥ 2, unless *N* = 1;
- *K* ≤ `maxJury()` (50 by default) and *K* ≤ the keeper's `shortlistSize()` (60);
- `tPlus()` < timeout ≤ `maxTimeout()` (155 s and 3600 s by default);
- timeout ≤ one day (86,400 s), whatever `maxTimeout()` says (`AggregatorLib.MAX_TIMEOUT`).

The contracts' owner sets `maxJury`, `maxTimeout` and `tPlus` with `setLimits`; a `maxTimeout` above a day is accepted, but no request can use more than a day. A bigger jury costs more (see [Funding a Request](#funding-a-request)) and its draw uses more gas.

The commit window *T*+ (155 seconds after the draw, `tPlus()`) is the same for every request.

The other settings are the same for every size: a bonus multiplier of 3 (`bonusMultiplier()`), a draw reward of 2 fees (`drawRewardFees()`) with 30 seconds' priority for the requester (`requesterDrawPriority()`), a promote reward of 1 fee (`promoteRewardFees()`), a reveal window of 120 seconds (`revealWindow()`), a settlement budget per request of 2 × its *K* slots (`settlePerRequest()`), and a highest fee one arbiter may charge of 0.0004 ETH (`maxOracleFee()`). Beacons (`JuryBeacons`) pick 4 arbiters and use the first 2 values revealed within 120 seconds. The contracts' owner can change all of these; a round keeps the jury and rewards it was requested with.

The section will show how you as a developer can submit a request and retrieve results, with code examples in JavaScript and Solidity.

## Coding: Requesting a Verdikta AI Evaluation

In Verdikta, programmatic users interact with the Aggregator contract to request AI evaluations. This contract not only handles processing queries and aggregatiing of results, but also tracks the performance of arbiters. To initiate a straightforward request, you need to do one thing off chain and one thing on chain: off chain, format your request and post it to IPFS; on chain, call the request function with the ETH that funds it attached. Let's go through these steps with example code.

### Format Your Request

A request is created by placing files describing the query into a directory, zipping that directory, and posting it to IPFS. The minimal number of files in the zipped directory is two: `manifest.json` and a document referenced by `manifest.json` describing the query. You can also add supporting documents, including various media files. The `manifest.json` file must include a version (currently 1.0), a pointer to the primary query document, and AI evaluation parameters. For example, look at the following simple `manifest.json` file:

```json
{
  "version": "1.0",
  "primary": {
    "filename": "primary_query.json"
  },
  "juryParameters": {
    "NUMBER_OF_OUTCOMES": 2,
    "AI_NODES": [
      {
        "AI_MODEL": "gpt-5.2-2025-12-11",
        "AI_PROVIDER": "openai",
        "NO_COUNTS": 1,
        "WEIGHT": 0.5
      },
      {
        "AI_MODEL": "claude-sonnet-5",
        "AI_PROVIDER": "anthropic",
        "NO_COUNTS": 1,
        "WEIGHT": 0.5
      }
    ],
    "ITERATIONS": 1
  }
}
```

The above file asserts that the text file describing the query is `primary_query.json`, a file that must be placed in the same directory as the `manifest.json` file. The text further indicates that the query has two possible answers. It prescribes that two AI engines be used in analysis with each running once, and the two answers from the two AI engines given equal weight. It further indicates that the number of iterations of the whole process be one.

Name models from the pool of the class you request (class 128 in the examples below): an arbiter registered on a class is set up to serve that class's models and need not have any other. Pools change as providers release and retire models, so take the names from the [ClassID usage guide](https://docs.verdikta.org/verdikta-common/CLASSID_USAGE_GUIDE/), which listed both models above for class 128 on 2026-11-22. Each class also limits the size of a request (for class 128: at most 20 outcomes, 5 models and 3 iterations).

The textual query document can be very simple. For example, here is a `primary_query.json` file asking the philosophical computer-science question of whether P equals NP:

```json
{
  "query": "P=NP",
  "outcomes": [
    "True",
    "False"
  ]
}
```

These two files, `manifest.json` and `primary_query.json`, can be put in a single directory and zipped together to form a query. Note the files inside the directory should be zipped, not the folder containing them. Here is an example shell script to do that:

```bash
#!/bin/bash
# Usage: ./scripts/zipDirShort.sh /path/to/dir [archive-name.zip]

d="${1%/}"
z="${2:-$d/$(basename "$d").zip}"
(cd "$d" && zip -r -q -X "$z" . -x "$(basename "$z")")
```

This produces, for example, a file named `query.zip` if the folder name is `query`. This `query.zip` file can then be uploaded to IPFS for access by the Verdikta process. Here is an example script to do this using Pinata, with the Pinata key (`IPFS_PINNING_KEY`) defined separately in the file `.env`:

```bash
#!/bin/bash
# Example: ./scripts/uploadIPFSShort.sh ./test/query/query.zip

set -euo pipefail

[ -f .env ] && source .env # load keys from current dir

f=$1 # file to upload
n=${2:-$(basename "$f")} # display name (default: file name)
u="${IPFS_PINNING_SERVICE:-https://api.pinata.cloud}/pinning/pinFileToIPFS"

curl -sSL -X POST -H "Authorization: Bearer $IPFS_PINNING_KEY" \
-F "file=@$f" -F "pinataMetadata={\"name\":\"$n\"};type=application/json" \
"$u" | jq -r '.IpfsHash // .cid // .IpfsCid'
```

This uploads the zipped query file and prints its IPFS CID, a string that starts with `Qm` or `bafy`. The examples below use `Qma8vc6pEHEgFQkjS6qZbK4Ue8S7SkdhQ6eqLV2hcrDD53`, a small test package ("The sky is blue.", True or False) that the [query script in the dispatcher repository](https://github.com/verdikta/verdikta-dispatcher/blob/master/reputationBasedAggregator/scripts/single-query.js) also uses. Put the CID of your own upload in its place.

### Funding a Request

With the query now available on IPFS, the next step is to work out how much ETH to send with the request. There is nothing to approve and no token to buy: you pay in ETH, in the same transaction that makes the request.

You choose four things:

- a ceiling, `maxFee`: the highest fee you accept from any one arbiter. Arbiters whose posted fee is above your ceiling are not eligible, and a ceiling above the contract's own (`maxOracleFee()`, 0.0004 ETH by default) is lowered to that value. Call the result *eff*;
- a floor, `minFee` (0 for none): every juror, and every beacon used, is paid at least this, whatever fee it posted, and its bonus is figured on that amount. The floor may be above the ceiling: the ceiling decides who is eligible, the floor what you choose to pay;
- whether to use beacons, `withBeacons`;
- the jury, `(K, M, N, P, timeout)` (see [Jury Size](#jury-size)): the fee depends on its *K* and *P*.

The aggregator then requires a prepayment that covers the worst case, which `maxTotalFee(maxFee, minFee, withBeacons, K, P)` returns for the jury you will ask for:

```
juror       = max(eff, minFee)
maxTotalFee = juror × (K + bonus multiplier × P [+ 2 beacons]) + eff × (draw reward 2 + promote reward 1)
```

For the Small jury (K = 6, P = 3, bonus multiplier 3) with a ceiling of 0.00015 ETH, no floor and no beacons, that is 0.00015 × (6 + 9) + 0.00015 × 3 = 0.00015 × 18 = 0.0027 ETH. For Jumbo (K = 50, P = 17, with beacons) at the same ceiling it is 0.00015 × (50 + 51 + 2) + 0.00015 × 3 = 0.0159 ETH.

What a round really costs is set by the drawn arbiters' own fees (or your floor, if higher), not by your ceiling. Each of the *K* jurors is credited its fee at the draw, and each of the *P* clustered arbiters gets three times its fee on top. At a posted fee of 0.00002 ETH for every juror, a Small round that completes costs 6 × 0.00002 + 9 × 0.00002 = 0.0003 ETH in arbiter fees, plus gas. The draw reward (2 × *eff*) and the promote reward (1 × *eff*) go to whoever sends those calls: if you send them yourself (the draw within 30 seconds), they come back to you. (You can read an arbiter's fee yourself: the aggregator's `keeper()` returns the Reputation Keeper's address, whose `getArbiter(key)` returns each arbiter's fee and scores; the `ArbiterRegistered` events list the arbiters.)

The rest of your prepayment is credited back to you in the aggregator's `ethOwed` ledger when the round ends (with the exceptions in [Failure and Refund Paths](#failure-and-refund-paths)). That credit pays for your next request: the contract takes from your credit only what your `msg.value` does not cover, and any ETH you send above `maxTotalFee` is added to your credit. You can also take it out with `withdrawEth()`.

### Making a Request

Here is an example script that sends the query with the CID above, moves the round through its steps and then reads the result. It needs Node.js 18 or later and the `ethers` library (`npm install ethers`), and a wallet key with a little ETH on Base in the environment variable `PRIVATE_KEY`. Because the v2 aggregator is not deployed yet, the address is a placeholder: set `AGG` to its address once it exists. The jury is set in the script (`JURY`, the Small preset); the same aggregator takes any other.

```javascript
#!/usr/bin/env node
// Usage: PRIVATE_KEY=0x... AGG=<V2_AGGREGATOR_ADDRESS> node request.js
// Base Sepolia: add RPC_URL=https://sepolia.base.org

const { ethers } = require('ethers');

/* ─── config ─────────────────────────────────────────────────────────── */

const RPC     = process.env.RPC_URL || 'https://mainnet.base.org';
const AGG     = process.env.AGG;                // v2 ReputationAggregator (not deployed yet)
const CID     = process.env.CID || 'Qma8vc6pEHEgFQkjS6qZbK4Ue8S7SkdhQ6eqLV2hcrDD53';
const CLASS   = 128;                            // class whose arbiters are asked
const ALPHA   = 500;                            // 0 = weigh quality only, 1000 = timeliness only
const MAX_FEE = ethers.parseEther('0.00015');   // highest fee accepted from one arbiter
const MIN_FEE = 0n;                             // fee floor: 0 = none
const BASE    = 8_000_000_000n;                 // estimated base cost in wei, below MAX_FEE
const SCALE   = 5;                              // limit on the preference for cheaper arbiters
const BEACONS = false;                          // true: draw the jury with beacon values
// the jury: K drawn, M promoted, N counted, P clustered, timeout (s from the draw).
// Small here; Medium 8/5/4/3/300, Large 21/16/13/10/300, Jumbo 50/38/27/17/600 (beacons on)
const JURY    = { K: 6, M: 5, N: 4, P: 3, timeout: 300 };
const DELAY   = 10_000;                         // poll every 10 s

const ABI = [
  'function requestAIEvaluationWithApproval(string[] cids, string addendumText, uint256 alpha, uint256 maxFee, uint256 minFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScalingFactor, uint64 requestedClass, bool withBeacons, (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout) jury) payable returns (bytes32)',
  'function maxTotalFee(uint256 maxFee, uint256 minFee, bool withBeacons, uint8 K, uint8 P) view returns (uint256)',
  'function ethOwed(address payee) view returns (uint256)',
  'function getJury(bytes32 aggId) view returns (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout)',
  'function drawJury(bytes32 aggId)',
  'function closeCommits(bytes32 aggId)',
  'function promote(bytes32 aggId)',
  'function settle(bytes32 aggId)',
  'function getRoundInfo(bytes32 aggId) view returns (uint8 phase, uint256 requestBlock, bytes32 sealedHash, uint256 closeBlock, uint256 received, uint256 baseFees, uint256 bonuses, uint256 rewards, uint256 deadline, uint256 windowEnd, uint256 commits, uint256 requestTime)',
  'function getEvaluation(bytes32 aggId) view returns (uint256[] likelihoods, string justifications, bool hasValidData)',
  'event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)',
];

/* ──────────────────────────────────────────────────────────────────── */

(async () => {
  if (!AGG) throw new Error('set AGG to the v2 aggregator address');
  const provider = new ethers.JsonRpcProvider(RPC);
  const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const agg = new ethers.Contract(AGG, ABI, signer);

  /* send one step with half as much gas again as the estimate; a step that
     is not due (or that someone else already sent) reverts, which is fine */
  const send = async (name, ...args) => {
    try {
      const gas = await agg[name].estimateGas(...args);
      await (await agg[name](...args, { gasLimit: (gas * 3n) / 2n })).wait();
      console.log(name, 'sent');
    } catch (e) {
      console.log(name, 'not sent:', e.shortMessage || e.message);
    }
  };

  /* size the prepayment: credit you already hold in the aggregator is used first */
  const required = await agg.maxTotalFee(MAX_FEE, MIN_FEE, BEACONS, JURY.K, JURY.P);
  const credit = await agg.ethOwed(signer.address);
  const value = credit >= required ? 0n : required - credit;
  console.log('worst case:', ethers.formatEther(required), 'ETH; sending:', ethers.formatEther(value), 'ETH');

  /* send the request with its jury: it only escrows the ETH (and may settle older rounds) */
  const args = [[CID], '', ALPHA, MAX_FEE, MIN_FEE, BASE, SCALE, CLASS, BEACONS, JURY];
  const gas = await agg.requestAIEvaluationWithApproval.estimateGas(...args, { value });
  const tx = await agg.requestAIEvaluationWithApproval(...args, { value, gasLimit: (gas * 3n) / 2n });
  console.log('tx:', tx.hash);
  const rcpt = await tx.wait();
  const aggId = rcpt.logs
    .map(l => { try { return agg.interface.parseLog(l); } catch {} })
    .find(l => l?.name === 'RequestAIEvaluation').args.aggRequestId;
  console.log('aggId:', aggId);

  /* move the round on until it has a result or has failed; M is the round's own */
  const { M } = await agg.getJury(aggId);
  while (true) {
    const r = await agg.getRoundInfo(aggId);
    const phase = Number(r.phase);
    const block = BigInt(await provider.getBlockNumber());
    const now = BigInt((await provider.getBlock('latest')).timestamp);
    if (phase === 6 || phase === 7) break;                       // result available
    if (phase >= 8) { console.log('round failed or was cancelled, phase', phase); return; }
    if (phase === 1 && block >= r.requestBlock + 2n) await send('drawJury', aggId);
    else if (phase === 2) await send('drawJury', aggId);         // beacons: second draw
    else if (phase >= 3 && now > r.deadline) await send('settle', aggId);
    else if (phase === 3 && now > r.windowEnd && r.commits >= M) await send('closeCommits', aggId);
    else if (phase === 4 && block >= r.closeBlock + 2n) await send('promote', aggId);
    await new Promise(res => setTimeout(res, DELAY));
  }

  const [scores, justif] = await agg.getEvaluation(aggId);
  console.log('scores:', scores.map(s => s.toString()).join(', '));
  console.log('justification CIDs:', justif);
  console.log('your credit in the aggregator:', ethers.formatEther(await agg.ethOwed(signer.address)), 'ETH');
})();
```

This script initiates the Verdikta process analyzing your query, then sends the steps that are due: the draw, as soon as block *B*+2 exists (so the draw reward is yours), and `closeCommits` and `promote` if nobody else has sent them. If the round passes its deadline with no result, it sends `settle`, which closes the round as failed. With beacons the second `drawJury` reverts (`TooEarly`) until the beacon values are in; the script simply retries.

Note the gas limits. A request now only escrows, but it may also settle older rounds that are due (until twice its own jury size in slots is spent; the last round may overshoot), so its gas use depends on the state of the contract; the draw selects and dispatches the whole jury, so its gas grows with *K*. Measured on a local test network against the v2 contracts: about 2.0 million gas for a draw with *K* = 6, 3.7 million with *K* = 12, and 13.5 million with *K* = 50 and beacons, close to the 16.7 million per-transaction cap. The script therefore sets every limit to one and a half times the estimate; for the largest juries, clamp that to the cap in your own code.

The result consists of the scores for the two options presented (True or False) and the CIDs that can be used to look up the justifications for them. With the ceiling of 0.00015 ETH used here the script sends 0.0027 ETH for a Small jury; the last line of the output shows what is left of it as your credit. Using a Web browser, you can see the content of a justification CID using a publicly available IPFS node like `https://ipfs.io/ipfs/CID`, `https://dweb.link/ipfs/CID`, or `https://gateway.pinata.cloud/ipfs/CID`. If you want to get the content without a Web browser, you can use curl: `curl "https://ipfs.io/ipfs/CID"`, or ipfs, if installed: `ipfs get CID`. In all these cases, swap in your actual CID to replace the "CID" placeholder.

### Funding and Submitting a Request from a Smart Contract – Solidity Example

The Verdikta system can also be called from a smart contract. Given below is a Solidity example of a contract that does this. It passes on the ETH it is called with, so it does not have to be funded in advance.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

interface IReputationAggregator {
    // the jury a request asks for: K drawn, M promoted, N counted, P clustered, and the
    // round timeout in seconds from the draw
    struct Jury {
        uint8 K;
        uint8 M;
        uint8 N;
        uint8 P;
        uint40 timeout;
    }

    function requestAIEvaluationWithApproval(
        string[] calldata cids,
        string calldata addendum,
        uint256 alpha,
        uint256 maxFee,
        uint256 minFee,
        uint256 estimatedBaseCost,
        uint256 maxFeeScaling,
        uint64 jobClass,
        bool withBeacons,
        Jury calldata jury
    ) external payable returns (bytes32);

    function maxTotalFee(uint256 maxFee, uint256 minFee, bool withBeacons, uint8 K, uint8 P) external view returns (uint256);
    function getJury(bytes32 aggId) external view returns (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout);
    function drawJury(bytes32 aggId) external;
    function getEvaluation(bytes32) external view returns (uint256[] memory, string memory, bool);
    function getOutcomeScores(bytes32, uint256 outcome) external view returns (uint256[] memory, bool);
    // getRoundInfo returns 12 values; declaring only the first (the phase) reads just that one
    function getRoundInfo(bytes32) external view returns (uint8 phase);
    function withdrawEth() external;
}

contract DemoClient {
    IReputationAggregator public immutable agg;
    address public immutable owner;
    string[] private cids;
    bytes32 public currentAggId;

    uint256 public constant MAX_ORACLE_FEE = 15e13; // 0.00015 ETH per arbiter at most
    uint8 public constant K = 6;                    // the Small jury: 6 drawn, 5 promoted,
    uint8 public constant M = 5;                    // 4 counted, 3 clustered, 300 s
    uint8 public constant N = 4;
    uint8 public constant P = 3;
    uint40 public constant TIMEOUT = 300;

    event Requested(bytes32 id);
    event Result(bytes32 id, uint256[] scores, string justif);

    constructor(address aggregator) {
        agg = IReputationAggregator(aggregator);
        owner = msg.sender;
        cids.push("Qma8vc6pEHEgFQkjS6qZbK4Ue8S7SkdhQ6eqLV2hcrDD53");
    }

    // Worst-case ETH to send with request()
    function quote() external view returns (uint256) {
        return agg.maxTotalFee(MAX_ORACLE_FEE, 0, false, K, P);
    }

    // Send quote() as the value of this call. Credit this contract already holds
    // in the aggregator is used first, so a later call may need less, or nothing.
    function request() external payable {
        require(currentAggId == bytes32(0), "already pending");
        currentAggId = agg.requestAIEvaluationWithApproval{value: msg.value}(
            cids, "", 500, MAX_ORACLE_FEE, 0, 8e9, 5, 128, false,
            IReputationAggregator.Jury(K, M, N, P, TIMEOUT)
        );
        emit Requested(currentAggId);
    }

    // From two blocks after request(). Drawing through this contract, the requester,
    // within 30 s earns the draw reward for this contract.
    function draw() external {
        agg.drawJury(currentAggId);
    }

    function publish() external {
        (uint256[] memory s, string memory j, bool has) = agg.getEvaluation(currentAggId);
        uint8 phase = agg.getRoundInfo(currentAggId);
        if (has) {
            emit Result(currentAggId, s, j);
            currentAggId = bytes32(0);
        } else if (phase == 8 || phase == 9) {   // failed or cancelled
            currentAggId = bytes32(0);
        } else {
            revert("not ready");
        }
    }

    // How many jurors scored `outcome` at or above `min` (0..1,000,000): a Q-of-N rule
    function jurorsAtOrAbove(bytes32 id, uint256 outcome, uint256 min) external view returns (uint256 n) {
        (uint256[] memory scores, bool valid) = agg.getOutcomeScores(id, outcome);
        require(valid, "no result");
        for (uint256 i = 0; i < scores.length; i++) if (scores[i] >= min) n++;
    }

    // Pull this contract's unspent prepayments and rewards out of the aggregator and pass them to the owner
    function reclaim() external {
        agg.withdrawEth();
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "send failed");
    }

    // The aggregator sends the reclaimed ETH here
    receive() external payable {}
}
```

After deploying this contract (using a tool like Hardhat or Foundry) with the aggregator's address, read `quote()` and call `request()` with that amount of ETH, then call `draw()` from two blocks later, with a gas limit about half as much again as your wallet's estimate. The contract function it uses is `requestAIEvaluationWithApproval()`, which is payable: the ETH travels with the call and no token approval is involved. The other steps need no special caller: anyone, including you, can send `closeCommits(aggId)` and `promote(aggId)` to the aggregator when they are due, and `settle(aggId)` after the deadline (the [script above](#making-a-request) shows when each is due). When the result is on chain, `publish()` emits it; when the round failed or was cancelled, it clears the request. Because the aggregator sees this contract as the requester, the unspent part of each prepayment and the draw reward are credited to the contract, not to you: `reclaim()` collects them and passes them to the address that deployed the contract.

## Operation Details

### Random Selection of Arbiters

When a round is drawn, the Verdikta smart contracts (Aggregator and Keeper) choose which arbiters (oracles) will evaluate it. This has to be fair and unpredictable, otherwise a malicious party could try to steer sensitive cases to "friendly" arbiters.

Verdikta achieves this in three steps:

1. **Fix the seed and the state**  
   The request is recorded in block *B*, and the draw happens from block *B*+2 with the seed `keccak256(aggId, blockhash(B+1))`, mixed with 2 beacon values when the request asked for beacons. The keeper checkpoints everything selection reads (scores, fees, stake, health calls) by block, and the draw reads it as of block *B*. Nothing that happens after the request, including who calls `drawJury` and when, changes the jury.

2. **Build a shortlist of eligible arbiters**  
   An arbiter is eligible if it is registered for the requested class, is not paused, banned, exiting, blocked, under-staked or frozen (an unanswered health call), and its posted fee (in ETH) ≤ your ceiling. The keeper visits the class's list in a random order derived from the seed and stops once it has 60 eligible arbiters (`shortlistSize()`) or has visited 400 entries (`maxScan()`). If fewer than *K* are eligible, the jury repeats arbiters: the *m* eligible ones are drawn, and slot *k* holds pick *k* mod *m*, so an arbiter may hold several slots (and is paid for each). Only when none is eligible does the round fail at the draw, and your prepayment is refunded.

3. **Run a weighted-random draw**  
   For every shortlisted arbiter *i* the contract computes a weight as follows:

   $$w_{i} = \left(1000 + \frac{1000 \cdot R_{i}}{\text{cap}}\right) \cdot \text{clamp}\left( \frac{F_{\max} - \beta}{\max(\text{fee}_{i}, F_{\min}) - \beta},1, S_{\max} \right), \qquad R_{i} = \frac{(1000 - \alpha)Q_{i} + \alpha T_{i}}{1000}$$

   The first factor is a reputation weight between 1000 and 2000; the second is a fee-based factor between 1 and *S~max~*, which is *S~max~* for a fee at or below β. The user specifies the timeliness-versus-quality weight α, the max scaling parameter S~max~, the base cost β, the max fee F~max~ (the ceiling) and the fee floor F~min~ when making the request. *Q~i~* and *T~i~* are arbiter *i*'s quality and timeliness scores (0 to `cap`, 1000 by default), and *fee~i~* is its posted fee. Because the fee factor uses the fee you actually pay, a fee posted below your floor gains no extra weight.

The contract then draws the request's *K* arbiters (or all *m* eligible, if fewer) one after another without replacement, each with a probability proportional to its weight among those not yet drawn:

$$P_{i} = \frac{\text{w}_{i}}{\sum\text{w}_{j}}$$

Each juror, and 3 other shortlisted arbiters chosen at random (`liveRandom()`), is sent a health call, which keeps the pool's liveness checked.

### Reputation Tracking

Verdikta keeps two numeric scores for every arbiter (operator-contract/job-ID pair), each an integer from 0 to 1000 (`points().cap`) that starts at 500:

| **Counter**        | **What it measures**                          |
|-------------------|----------------------------------------------|
| **Quality Score** | How close the arbiter's revealed answer is to the median of the round's answers |
| **Timeliness Score** | Whether the arbiter delivered: committed and, if promoted, revealed |

These scores are updated when a round is settled (`settle(aggId)`, after its deadline): the aggregator reports one outcome per juror to the Reputation Keeper's `applyOutcomes()`. The table below shows what happens in each situation, with the default points (`points()`):

| **Event** | **Quality Change** | **Timeliness Change** |
|-----------|-------------------|---------------------|
| Promoted and revealed (also after aggregation, before the deadline), answer close to the median (within 1.5 robust spreads) | +20 | +20 |
| Promoted and revealed, answer off (within 3 spreads) | −50 | +20 |
| Promoted and revealed, answer far (beyond 3 spreads) | −200 | +20 |
| Promoted and revealed, but the round failed | 0 | +20 |
| Promoted but never revealed, round finished | 0 | −200 |
| Promoted but never revealed, round failed | 0 | −500 |
| Never committed, and the round failed for lack of commits | 0 | −400 |
| Committed but not promoted, or not committed in a round that did not fail for lack of commits | 0 | 0 |

The ETH *bonus* (fee × `bonusMultiplier()`, 3 by default) goes to the *P* arbiters whose answers form the cluster, which is decided separately from these quality classes. Every juror keeps its base fee in all cases: it is credited at the draw. An arbiter that was frozen at the round's deadline (an unanswered health call) is not scored at all, unless it committed in that round: a commit proves it was up.

Consequences of low scores:

- A score that reaches 0: the arbiter is blocked from selection for `lockDuration()` (24 h) × 2^offenses, the score restarts at 500, and the offense is counted. Scores hitting 0 again while already blocked add no offense.
- One offense is forgiven for each `decayPeriod()` (90 days) without a new one.
- The `maxOffenses()`-th (3rd) block is a permanent ban.
- A block can also burn `burnPerBlock()` × 2^offenses of the stake, and a ban the whole stake if `burnOnBan()` is set. Both are off by default (0 and false), so the default deterrent is lost income and lost selection, not lost stake.

These are defaults of the v2 Reputation Keeper; its owner can change them.

### Failure and Refund Paths

A round that cannot produce a result ends in one of the ways below. In every case the base fees credited at the draw stay with the jurors. Whatever is left of the prepayment is credited either back to the requester (`ethOwed`) or to the protocol's treasury (`treasury()`). It goes to the treasury where a refund would let a requester re-roll a jury it did not like for little cost.

| **What happened** | **Ends as** | **Who ends it** | **Unspent prepayment goes to** |
|-------------------|-------------|-----------------|--------------------------------|
| No eligible arbiter at the draw (with fewer than *K*, arbiters are repeated instead), or (with beacons) fewer than 2 beacon candidates | Phase 8, `EvaluationFailed(aggId, 1)` | the `drawJury` call | requester, at the draw |
| Fewer than *M* commits by the deadline | Phase 8, `EvaluationFailed(aggId, 3)` | `settle` | requester |
| Fewer than *N* reveals by the deadline | Phase 8, `EvaluationFailed(aggId, 5)` | `settle` | requester |
| At least *M* commits, but nobody called `closeCommits` after *T*+, or the phase was closed and nobody called `promote` | Phase 8, `EvaluationFailed(aggId, 3 or 4)` | `settle` | **treasury** |
| Beacon quorum missed (fewer than 2 values within 120 s) | Phase 8, `EvaluationFailed(aggId, 2)` | the second `drawJury` | **treasury** (the beacon that answered is paid) |
| Jury cannot be drawn after the beacon stage | Phase 8, `EvaluationFailed(aggId, 1)` | the second `drawJury` | requester if the keeper scans the whole class list (`keeper.scansAll(class)`), otherwise **treasury**; the beacons are paid |
| Seed never stored within 8,191 blocks (about 27 minutes), or stored but not drawn within a day | Phase 9, `RoundCancelled` | `cancelUnsealed(aggId)` | **treasury** (the whole prepayment) |

Notes:

- `settle(aggId)` is callable by anyone once the round's deadline has passed, and new requests settle due rounds automatically. Until a failed round is settled, `getEvaluation(aggId)` reports no data and `isFailed(aggId)` returns false: if you are waiting for a result, check the phase and deadline with `getRoundInfo(aggId)` and call `settle` yourself.
- `isFailed(aggId)` is true only for phase 8. A cancelled round is phase 9.
- `drawJury` reverts with `DrawExpired` more than a day after the request; `cancelUnsealed` is then the only way to end the round.
- The draw is cheap to protect: send it (or `sealSeed(aggId)`) within a few minutes of the request, and send `closeCommits` and `promote` when they are due. The draw and promote calls pay their caller, so in practice others may send them first.

### Decentralization and Robustness

Because of the combination of random selection, staking, and reputation:

- No single arbiter can unduly influence results (they never know which requests they'll get, and even if one is corrupt or buggy, the others will outvote them).

- The network is tolerant to some arbiters being down or behaving poorly; the worst that happens is those arbiters lose reputation, are frozen or blocked for a time, are selected less often or not at all, and, where a burn is configured, lose stake, and are disincentivized from repeating it. The final results remain trustworthy as long as a majority (or a quorum) of arbiters per request are honest. This assumption is similar to many Byzantine fault tolerant systems, where the protocol works correctly if, say, 2 out of 3 oracles are honest.

- There is an economic force incentivizing honesty. An arbiter that acts wrong gives up the bonus, which is three quarters of what a clustered arbiter earns on a request, and the reputation that gets it selected. The design also lets the contract burn stake from such an arbiter; by default that amount is zero, so the deterrent is lost income and lost selection, not lost stake.

How far these properties hold at a given moment depends on how many independent operators run arbiters, and that can be read from the chain. v2 is a new deployment: every arbiter registers again, so there is no v2 pool to describe yet. To check it once it exists, list the `ArbiterRegistered` events of the Reputation Keeper, read `classSize(class)` and `getArbiter(key)` there, and read `owner()` on each operator contract.

### Transparency and Community Oversight

Verdikta's use of Ethereum and Base means that all of these actions are transparent. The addresses of arbiters, their stakes, their reputation scores (stored on chain in the Reputation Keeper), and their responses (the scores and IPFS hashes they submit) are publicly visible. This transparency lets the community audit Verdikta. If an arbiter is behaving oddly, everyone can see it. If the selection randomness were somehow failing, it'd be evident on-chain. This open data builds trust that Verdikta operates as advertised.

### Reading Results On-Chain

The Verdikta Reputation Aggregator contract stores the final results and emits them in an event. Ways to retrieve results include the following:

• **View function:** call `getEvaluation(aggId)` to obtain the aggregated score array, a comma-separated string of justification CIDs, and a flag that is true once the round has a result (phase 6, before settlement, or 7). This is convenient for off-chain calls (e.g., from your front-end or script). For example, `aggregator.getEvaluation(aggId)` might return `([850000,150000], "QmX...abc,QmY...def,QmZ...ghi", true)`, meaning scores of 85% and 15% and the IPFS CIDs of the clustered arbiters' justifications.

• **Each juror's score:** call `getOutcomeScores(aggId, outcome)` to obtain every counted reveal's raw score for one outcome, in reveal order, and a flag that is false until the round has a result (and for a failed round). This lets a consumer apply its own rule, for example "at least *Q* of the *N* jurors scored above the threshold", instead of using only the average.

• **Events:** a `FulfillAIEvaluation` event is emitted when an evaluation finalizes. Its parameters include the aggregation ID, the aggregated score array, and the combined CID string. Events are logged on-chain and can be watched by off-chain services; if you listen for this event you can capture the result without making a function call. `EvaluationFailed(aggId, phase)` and `RoundCancelled(aggId, toTreasury)` report the other endings.

### Understanding the Aggregated Score

For a query with several outcomes, the result is an array with one score for each outcome, in the order in which the query lists the outcomes. The arbiter software produces scores that add up to 1,000,000, so 850,000 for an outcome means 85%. What the scores mean depends on your use case, perspective, or how you formulated the query:

- They could be probabilities or confidence levels (e.g., "850,000 for 'True' means an 85% confidence that the claim is true").

- With the two outcomes "yes" and "no", the score for "yes" could serve as a rating on a scale from 0 ("strongly no") to 1,000,000 ("strongly yes").

- The outcomes might be the parties to a dispute (for instance, "Party A wins" and "Party B wins"), with scores near 500,000 each meaning a tie or an inconclusive case.

**One-number results.** A query can also ask for a single number, such as a rating. Each arbiter then reveals one value, and the result is an array of length one. When single values are the most common answer length in a round, the aggregator clusters the values exactly, in one dimension, and cuts any longer answer to its first value. Read each juror's number with `getOutcomeScores(aggId, 0)`.

Your query defines how to interpret the scores. It's important that as a developer, you use them correctly in your application. For example, if Verdikta is used in an escrow contract to decide who gets the funds, you might say: if the score for "Seller" is above 500,000, the winner is the Seller; if it is below, the winner is the Buyer. The Verdikta Bounties escrow uses the individual jurors' scores: it counts the jurors whose acceptance score reaches the threshold the bounty's creator chose (0 to 100, times 10,000), and pays when at least the bounty's quota *Q* of them do ([`BountyRules.sol`](https://github.com/verdikta/verdikta-applications/blob/beacon/example-bounty-program/onchain/contracts/BountyRules.sol), on the `beacon` branch until v2 is released).

Because the aggregated score is the average of the answers of the clustered arbiters, it is generally a more robust metric than a single AI's output. If the clustered arbiters give roughly the same answer, the score is essentially that answer. If they vary, the score is somewhere in between. By design, Verdikta gives you one final score per outcome so you usually won't need to worry about internal disagreements – the system takes care of that for you – and the individual scores are there when you want them.

### Fetching and Using Justification CIDs

Verdikta's added value over a simple numeric oracle is that it provides justifications for transparency. The result includes one or multiple IPFS CIDs where the reasoning is stored. These are pointers to off-chain data that you (or users of your dApp) can retrieve to see *why* the AI came to the conclusion it did.

To use the CIDs:

1. Choose an IPFS gateway or IPFS node to fetch from. If you have ipfs installed or are using a service like Infura, Pinata, or Cloudflare's IPFS gateway, you can input the CID to get the content. For example, if a justification CID is `QmY...def`, you could use a gateway URL like `https://ipfs.io/ipfs/QmY...def` or `https://gateway.pinata.cloud/ipfs/QmY...def` in a browser. Many gateways exist; developers might use an IPFS HTTP client in code to fetch the JSON/text.

2. The content you get back is typically a text explanation (possibly structured text or JSON). It might read like: *"The AI determined that Party A breached the contract because the evidence X clearly shows... and according to clause Y, Party A is liable. Therefore, Party B should win the dispute."* This is immensely helpful for human verification. Your application could display this explanation to users to increase trust in the automated decision.

3. If multiple CIDs are returned (say two justifications from two arbiters), you can retrieve all of them. They might be very similar if all AIs agreed, or there might be subtle differences in phrasing or even perspective. Perhaps one justification provides a bit more detail on one aspect, while another adds a different viewpoint. As a developer, you could show these to the end-user.

**Gas and Storage Consideration:** The justifications are *not stored on-chain—*only their CIDs are. This is by design to keep gas costs reasonable. Storing large text on Ethereum (or any chain) is expensive. IPFS offloads that storage. The trade-off is that retrieving justifications requires off-chain action (which is fine, since it's mostly for human reading or off-chain processes). The score, however, being on-chain, can be used by other contracts directly. For example, your smart contract could automatically do something if the score exceeds a threshold, all in one transaction, because it can call Verdikta's contract to get the score within its execution. It can't, of course, understand the IPFS justification text on-chain – that's purely for off-chain transparency and user information.

## Verdikta Direct Interaction Portal

While the focus of this guide is programmatic integration, it's worth mentioning the Verdikta Direct Interaction website, the [Verdikta Playground](https://playground.verdikta.org) – a front-end tool provided by the Verdikta team for experimentation and user convenience. This web portal offers a user-friendly interface to test Verdikta without writing any code. Its source is the [example frontend](https://github.com/verdikta/verdikta-applications/tree/main/example-frontend) in this repository.

On the Verdikta Direct Interaction site, you can:

- **Submit Natural Language Queries:** If you have a question or a dispute description, you can simply type it into the interface (for example, paste a scenario or a prompt). The site uploads your input to IPFS (turning it into a CID) – essentially *"CID-ifying"* your natural language input – and then call the Verdikta contract on your behalf. This is great for quickly trying out Verdikta's capabilities or demonstrating it to non-developers. You don't need to manually deal with IPFS; the site handles it.

- **Provide Existing CIDs:** If you already have data on IPFS (maybe you prepared a JSON file with all necessary info), you can provide the CID directly. The site can use that to call the contract, skipping the upload step.

- **Manage Funding:** The site connects to a web3 wallet (MetaMask) so you can pay the fee in ETH through a simple UI. The site works out the prepayment and has you confirm the transaction for `requestAIEvaluationWithApproval()`; there is no token to approve. With the v2 aggregator your wallet then also confirms the steps that move the round on (the draw, and closing and promoting the commit phase when nobody else has); see the [Run Query page](example-frontend/run-query.md).

- **View Results:** After the request is processed, the site displays the aggregated scores and fetches the justifications for you. It might show the result in a user-friendly way, for example as the percentage each outcome received, and then the text explanations below it. This saves you the trouble of manually using an IPFS gateway.

The Verdikta Direct Interaction portal essentially wraps all the steps we've described in a nice UI. It's ideal for learning and for stakeholders to play with Verdikta. However, for integration into your own project, you'd use the programmatic approach (Solidity/JavaScript) as described above. The portal can also serve as a reference – you might inspect the browser console or network calls to see how exactly it's interacting with the contract.

## Conclusion

Verdikta enables a new class of smart contract applications by providing trustless AI evaluations on-chain. By combining blockchain technology, decentralized agents, and AI, it allows developers to create contracts that can make complex judgments or assessments in an automated yet trustworthy manner. In this document, we covered how Verdikta works and how to use it:

- We reviewed how smart contracts, Chainlink, and IPFS support Verdikta.

- We explained Verdikta's trustless AI approach, using multiple AI arbiters to ensure no single point of failure or trust.

- We went through the mechanics of submitting a request via the Aggregator contract, including funding the request, calling `requestAIEvaluationWithApproval()`, drawing the jury and moving the round through its commit and reveal phases.

- We provided code snippets in Solidity and JavaScript to illustrate integration—from sizing the ETH prepayment to calling the contract and retrieving results.

- We covered the selection of arbiters, showing how Verdikta provides fair randomness to pick arbiters and how staking and reputation incentivize honest behavior, keeping the system secure and robust.

- We listed how a round can fail and where its unspent prepayment goes in each case.

- We showed how to read the results (score and justification CIDs) and what to do with them, emphasizing the benefit of having human-readable explanations stored on IPFS alongside the numeric outcome.

- Finally, we mentioned the Verdikta Direct Interaction web portal for easy experimentation.

With this knowledge, you should be well-equipped to onboard Verdikta into your project. Whether you're building a decentralized dispute resolution platform, a content curation DAO that needs AI moderation, or any DApp that could use impartial AI judgments, Verdikta provides the tools to do it in a decentralized way. Integrating AI into smart contracts is cutting-edge, and by using Verdikta, you're at the forefront of marrying AI and blockchain. The Verdikta community and team are eager to support developers, so be sure to reach out, read the official docs for any updates, and perhaps even contribute feedback or improvements.

Happy coding, and welcome to the world of trustless AI-powered smart contracts!