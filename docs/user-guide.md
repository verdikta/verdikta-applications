# Verdikta User Guide: AI-Powered Evaluations for Smart Contracts

**Version Alpha-1**

## Introduction

Verdikta brings trustless AI to blockchain applications. It enables smart contracts and decentralized applications (dApps) to request AI evaluations (for example, for dispute resolutions or content analysis) that are decided by multiple random AI agents called "arbiters." Using Verdikta, developers can integrate complex AI reasoning into on-chain logic without relying on a centralized service. This guide walks you through the concepts and steps to use Verdikta, from understanding the underlying technologies to the process of submitting requests and retrieving results. We'll cover the basics of smart contracts, Chainlink oracles, and IPFS, explain how Verdikta works, and provide code examples in Solidity and JavaScript to help you get started.

## Background Concepts

Before diving into Verdikta details, it's important to understand its underlying technologies: smart contracts, Chainlink oracles, and IPFS. If you're already familiar with these, feel free to skip ahead. For those less familiar, the following is a brief overview.

### Smart Contracts

Smart contracts are self-executing programs that run on a blockchain. They enforce rules and agreements in code without manual oversight. Once deployed, a smart contract's code is tamper-proof and transparent: it always executes as written when its functions are called. This enables trustless execution of transactions---such as holding funds in escrow and releasing them based on predefined conditions. However, by default smart contracts only have access to on-chain data. They cannot directly access external information (like web API data or AI computations) on their own. This is where oracles come in.

### Chainlink Oracles and Decentralized Trust

Oracles bring external information into the blockchain. Chainlink is a prominent decentralized oracle network that connects smart contracts to off-chain data and computation. Oracles act as bridges, feeding the external information into the blockchain in a secure and reliable way. A Chainlink oracle network consists of many independent node operators that fetch or compute data and reach consensus on the result, which is then delivered on-chain for use by smart contracts. This decentralized design is crucial because having to trust a single oracle operator, what in Verdikta is called an arbiter, would undermine the trustless nature of smart contracts. In this document, "trustless" means not having to trust a single entity.

For example, Chainlink Data Feeds can aggregate price data from many sources to provide tamper-resistant price oracles in DeFi. Similarly, Chainlink can be used to connect AI models to smart contracts. Rather than trusting a single AI API, an oracle network can call multiple AI models or services and aggregate their responses. This increases reliability: if one model is wrong or biased, the others can outvote it. Verdikta leverages this principle by having multiple AI arbiters evaluate each query using multiple AI algorithms and intelligently combining all the results.

### IPFS

IPFS (InterPlanetary File System) is a decentralized file storage and sharing network. It allows data (like documents, images, or JSON blobs) to be stored broadly and referenced by a unique cryptographic hash, called a CID (standing for Content Identifier). Unlike a traditional URL that points to a location on a specific server, a CID is a signature that points to content itself. IPFS provides a content-addressable, peer-to-peer method for storing and sharing data. In practice, this means if you have some data (for example, a text description of a dispute or a query for an AI model), you can add it to IPFS and get back a CID. Then anyone with that CID can retrieve the data from the IPFS network knowing it is unchanged because if the content were changed in any way it would produce a different CID.

Verdikta uses IPFS to handle the often large amounts of data associated with AI evaluations. Instead of putting a whole essay or case description on the blockchain (which would be expensive and impractical), the user provides a comparatively short (less than 100 characters) CID pointing to the data on IPFS. The arbiters fetch the content from IPFS off-chain, evaluate it with AI, and then similarly store any detailed justifications or responses back to IPFS. The smart contract only needs to store and forward CIDs. Using IPFS in this way keeps Verdikta's on-chain footprint small while maintaining decentralization (the data isn't reliant on a single server) and integrity (information is addressed by its content, so everyone can be sure of getting the correct data).

## Trustless AI for Smart Contracts

Trustless AI refers to the ability to incorporate AI-driven decisions into smart contracts without having to trust a single AI provider. The goal is to get on-chain AI results that are accurate and manipulation-resistant. This is a new frontier because leading AI models are typically run on centralized servers. Verdikta's approach is to decentralize the evaluation process: multiple independent AI agents (the arbiters) evaluate a query, with the results combined on-chain in a smart contract called the Aggregator using rules that incentivize honesty and accuracy. In addition to a base fee paid to all participating arbiters, bonuses are paid to the arbiters that respond quickly and accurately, as determined by clustering results. A separate special smart contract, the Reputation Keeper, maintains timing and quality reputation scores for the arbiters and uses these to increase the chances of selection for future queries. The organization of the Verdikta system is illustrated in the figure below.

![Verdikta System Architecture](images/media/image1.emf)

The benefits of this approach include the following:

- **Reliability and Accuracy:** By aggregating outputs from multiple AI models and instances, operated by many different entities on different platforms, Verdikta reduces the risk of failure or a single model's inaccuracy or misrepresentation. The arbiter network consensus approach means the final result represents broader agreement. The system "crowd-verifies" the answer.

- **No Single Trusted Party:** Users do not have to trust any one person or entity. The arbiters are decentralized and chosen at random, and their outputs are combined in a smart contract. Even if one arbiter is malicious or faulty, it will be outweighed by others.

- **Verifiability:** The code and output for the smart contracts is public, and anyone can verify that the process (random selection, funds commitment, response validity, scoring) was followed correctly. While the AI reasoning process is off-chain, multiple random nodes agreeing on the output provides validation.

- **Incentive Alignment:** Verdikta incorporates a reputation and staking system (discussed in detail later) to economically motivate honest behavior. The AI arbiters are held accountable for the quality of their outputs via reputation scores and penalties and rewards. Incentive compatibility---where providers can be rewarded or penalized depending on the quality of their data---is vital for a trustless system.

In summary, Verdikta's trustless AI mechanism allows smart contracts to confidently use AI-generated decisions (like "Who wins this dispute?" or "Is this content acceptable?") knowing that the answer was derived in a decentralized, tamper-resistant way. With these concepts in mind, let's next look at how Verdikta itself is structured and how to use it.

## The Verdikta System 

Verdikta uses multiple logical components. On-chain there is the Aggregator's combinatorial logic and the Reputation Keeper's staking and reputation-management mechanism for arbiters. Off-chain, there are many instances of software---variously owned and operated---that perform the actual AI computations. Let's break down the roles and the flow of an evaluation request.

### Components

- **User (Requester):** This is you (or your smart contract) requesting an AI evaluation. For example, you might be developing a dApp that needs an AI to score a piece of content or resolve a dispute between two parties. Typically, the user formulates the query and stores it on IPFS before calling the Verdikta contract to start an evaluation.

- **Aggregator Contract:** This is the core Verdikta smart contract deployed on-chain. It coordinates the process. Its responsibilities include the following: receiving evaluation requests, selecting a set of arbiters randomly to handle each request, collecting their responses through a commit-reveal process, aggregating the results (e.g. computing an average score or majority vote), and updating arbiters' reputations. You interact directly with this contract to request evaluations and fetch results.

- **Reputation Keeper Contract:** The Aggregator contract relies on a separate Reputation Keeper contract to do its job. This smart contract executes the Stake and Reputation System. Each arbiter has skin in the game. Arbiters stake Verdikta tokens to register with the Reputation Keeper, which they stand to lose access to if they behave dishonestly or underperform. The reputation scores measure past performance. If an arbiter consistently responds quickly and agrees with the consensus result, its reputation scores go up; if an arbiter deviates or fails to respond, its reputation scores go down. The Reputation Keeper uses timeliness and quality ratings for each arbiter to decide eligibility to participate and to determine likelihood of selection in queries. The use of staking and reputation scoring creates an incentive structure where arbiters are motivated to provide truthful, high-quality answers.

- **AI Arbiters:** These are Verdikta logical nodes (Chainlink nodes working with other software) running AI models. Each arbiter is uniquely identified by a combination of 1) an operator contract address and 2) a Chainlink Job ID. An operator registers this identifier pair with the Verdikta network by staking 100 Verdikta tokens. Arbiters each have two reputation scores that are tracked. One is for timeliness and the other is for quality. When a new request comes in, a subset of all registered arbiters is randomly selected using blockchain and arbiter-generated entropy to process the query. The randomness used in the Verdikta commit-reveal process is incorporated into rolling entropy: this lets Verdikta requests add 80 new bits of randomness that future selections can't predict. Each selected arbiter retrieves relevant query data from an IPFS node (using the CID provided), runs AI models to evaluate it, and produces an output in the form of numerical scores (the decision) and a textual justification explaining the reasoning. The justification is uploaded to IPFS by the arbiter, yielding a content-hash CID for conveying the explanation text. The arbiter submits its score and the justification CID back to the ReputationAggregator contract as its answer.

- **Verdikta Payment:** Verdikta's services are not free---users must pay in cryptocurrency for each AI evaluation request. This fee rewards the arbiters and compensates for their costs (e.g., blockchain access, AI access, and data storage/retrieval). The fee is paid in Chainlink's LINK token. In Verdikta's system, the `requestAIEvaluationWithApproval()` function requires the user to approve the contract to pull the fee in LINK. We will see how to handle this in the usage section.

### How an Evaluation Request Works (Lifecycle)

Here is a step-by-step outline of what happens when you request an AI evaluation on Verdikta:

1. **Query Preparation:** The user prepares the query data and stores it on IPFS, obtaining a content hash, the CID. The query takes the form of comma-delimited CIDs followed by optional colon-delimited text. Here is the pattern: `CID1,CID2,...,CIDN:TEXT`.

2. **Query CID Details:** The first CID in the query represents data in the following form: It is a zipped directory holding files, one of which is named `manifest.json`. This JSON manifest file holds 1) a version number, 2) a name for the primary file describing the query, 3) jury parameters including which AI models to query and how to weight them, and 4) a list of supporting files. Additional CIDs can hold additional supporting files. Often just one CID will be used, while the optional use of multiple CIDs allows data to originate at different times and from different sources, which is useful for some applications.

3. **Request Submission (On-Chain):** The user calls the Aggregator contract's function `requestAIEvaluationWithApproval()` to initiate the request. This call sends the CIDs and the optional text field as the first step of a commit-reveal process. This transaction also pays the required LINK fee (see next section for how to do this). The contract emits an event (`RequestAIEvaluation`) containing a unique request ID (needed for coordination with future communication) and the query data.

4. **Use of Multiple AI Engines:** With Verdikta, any number of AI types can be requested with any number of calls made to each. The ability to interact with a particular AI model type is determined by the arbiter's class, with some classes able to use frontier models from, for example, OpenAI and Anthropic, while others are able to run open source models. The request must match the class.

5. **Arbiter Selection (Random & Trustless):** When the request is received, the Reputation Keeper generates a random seed based on blockchain- and arbiter-supplied entropy. Using this randomness, it selects a set of arbiters from the pool of available, staked arbiters that support the requested class. The selection gives higher-weighted chances to those arbiters with better reputations. The Aggregator contract forwards the query as part of a commit-reveal process to the chosen arbiters.

6. **Commit-Reveal Process:** The Aggregator interacts with the arbiters in two steps. First it makes a request to a number of arbiters, nominally five, to process the query with AI but not return the result immediately. Instead the arbiters are asked to provide a cryptographic hash of the results plus a random salt as a commitment. The exact form of the hashed commitment is the following: 
   ```solidity
   bytes16 hash = bytes16(sha256(abi.encode(senderAddress, likelihoods, salt)))
   ```
   Once a specified number, nominally four, respond with a commitment of this form, those are then asked to reveal their AI results. This two-step process prevents a rogue arbiter from just copying the answer of another arbiter. A common ID, called the aggregation ID, is used with all these interactions for the same user query.

7. **Off-Chain Evaluation:** Each selected arbiter has software running on Internet-connected hardware. This software sees that it has been picked for processing with a given query package. Content is downloaded from IPFS using the provided CIDs (Always guaranteed through IPFS to yield the correct, untampered data). The arbiter software runs the AI evaluation and produces scores for the multiple options. It also produces a textual justification. The arbiter then stores this justification using IPFS, getting an IPFS CID to return in the results response.

8. **Submission of Results:** Each arbiter submits its evaluation back to the aggregator contract by calling a Chainlink operator callback that uses the `fulfill()` function. This includes the numeric scores and the CID of the justification.

9. **Aggregation of Results:** Once the aggregator contract receives enough responses (for example, if Verdikta requires three arbiters per request, it waits for three), it aggregates these results. Aggregation uses clustering and averaging, with the subset that most closely aggregates being averaged. This aggregated score is the trustless AI evaluation result. If the arbiters largely agree, this score reflects that consensus. If there was disagreement, the aggregation smooths it out. In all cases the outliers that are not clustered lose in reputation score.

10. **Finalize and Store Outcome:** The Aggregator contract finalizes the request by posting the clustered and averaged results on-chain. It maps the request ID to an aggregated score and justification set. Verdikta uses each arbiter's justification CID individually and passes the set for the clustered results back to the user.

11. **Payouts and Reputation Updates:** The Aggregator contract handles payments and reputation tracking. The clustered arbiters receive a reward (an amount equal to a multiple, like 3X, of the initial payment) for their work. If any arbiter failed to respond in time or submitted a deviant answer that was not clustered, the contract reduces their reputation. Conversely, if an arbiter's answer aligned with the final outcome (i.e., was clustered), its reputation increases. All these updates happen within the Aggregator, with the results conveyed to the Reputation Keeper, thereby updating the network state for future requests.

12. **Error Handling Path:** Callers can watch for `EvaluationFailed(aggId, "commit" | "reveal")` to detect failure early instead of polling forever. Separately, if there is insufficient arbiter response within the timeout period (300 s), the caller can trigger timeout closure, reclaim funds set aside for bonus payment, and penalize the nonresponding arbiters.

13. **Result Available to User:** Finally, on success the contract emits a `FulfillAIEvaluation` event (with the aggregator ID, final scores, and justification references). The user (or any interested party) can now retrieve the outcome. The user's original contract (if they used one to call Verdikta) can poll the Verdikta contract for the result.

All of this happens in a trustless way: the user made one transaction to request, and after some time (depending on how long the off-chain AI takes, typically within a couple of minutes), the result is on chain and nobody was trusted individually. Multiple independent arbiters and cryptographic randomness ensured the integrity of the process.

Here is a table of the configurable parameters in the arbitration process and the current established value in the fielded smart contracts:

| **Configuration Parameters**              | **Value** |
|-------------------------------------------|-----------|
| Arbiters polled for commit                | 5         |
| Committers promoted to reveal             | 4         |
| Revealers promoted to aggregate           | 3         |
| Number of clustered winners               | 2         |
| Payout multiplier for bonus to winners    | 3         |
| Maximum seconds to complete               | 300       |

The section will show how you as a developer can submit a request and retrieve results, with code examples in JavaScript and Solidity.

## Coding: Requesting a Verdikta AI Evaluation

In Verdikta, programmatic users interact with the Aggregator contract to request AI evaluations. This contract not only handles aggregation of results, but also tracks the reputation of arbiters. To initiate a straightforward request, you need to do one thing off chain and two things on-chain: off chain, format your request into the required form and post it to IPFS; on chain, fund the request (approve payment) and call the request function. Let's go through these steps with example code.

### Format Your Request

A request is created by placing files describing the query into a directory, zipping that directory, and posting it to IPFS. The minimal number of files in the zipped directory is two: `manifest.json` and a document referenced by `manifest.json` describing the query. You can also add supporting documents, including various media files. The format of the required `manifest.json` file is the following: it includes a version, a pointer to the query document, and AI evaluation parameters. For example, look at the following simple `manifest.json` file:

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
        "AI_MODEL": "gpt-4o",
        "AI_PROVIDER": "OpenAI",
        "NO_COUNTS": 1,
        "WEIGHT": 0.5
      },
      {
        "AI_MODEL": "claude-3-5-sonnet-20241022",
        "AI_PROVIDER": "Anthropic",
        "NO_COUNTS": 1,
        "WEIGHT": 0.5
      }
    ],
    "ITERATIONS": 1
  }
}
```

The above file asserts that the text file describing the query is `primary_query.json`, a file that must be placed in the same directory as the `manifest.json` file. The text further indicates that the query has two possible answers. It prescribes that two AI engines be used in analysis with each running once, and the two answers from the two AI engines given equal weight. It further indicates that the number of iterations of the whole process be one.

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

These two files, `manifest.json` and `primary_query.json`, can be put in a single directory and zipped together to form the query. Note the files inside the directory should be zipped, not the folder containing them. Here is an example shell script to do that:

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

This uploads the zipped query file and returns an IPFS CID, in this case, the CID is the following: `QmZ2BgPsmnn4T4ShbdryoTWXFM4nHt7tM674fU4CLVHthH`.

### Funding a Request

With the query now available on IPFS, the next step is to approve the aggregator contract to spend LINK in paying the arbiters on your behalf when you make a query. Here is a short JS script that does that (with addresses for Base Sepolia):

```javascript
#!/usr/bin/env node
// Example use: node scripts/approve-link.js 0.5

require('dotenv').config();
const hre = require('hardhat');
const { ethers } = hre;

const LINK = '0xE4aB69C077896252FAFBD49EFD26B5D171A32410'; // LINK token
const AGGREGATOR = '0x65863e5e0B2c2968dBbD1c95BDC2e0EA598E5e02';
const AMOUNT = ethers.parseUnits(process.argv[2] || '0', 18); // CLI amount

(async () => {
  const [signer] = await ethers.getSigners();
  const abi = (await hre.artifacts.readArtifact('LinkTokenInterface')).abi;
  const link = new ethers.Contract(LINK, abi, signer);
  
  const tx = await link.approve(AGGREGATOR, AMOUNT);
  console.log('approve tx:', tx.hash);
  await tx.wait();
  console.log('approved', ethers.formatUnits(AMOUNT, 18), 'LINK');
})();
```

### Making a Request

The above script, if run using a command of the form `node scripts/approve-link.js 0.5` authorizes the aggregator contract to fund arbiters up to a total of 0.5 LINK. This is more than enough to cover both up-front and bonus payments to the arbiters. After it is called you are ready to make the Verdikta query. Here is a script for querying with the CID created earlier and then polling for results:

```javascript
#!/usr/bin/env node

require('dotenv').config();
const hre = require('hardhat');
const { ethers } = hre;

/* ─── config ─────────────────────────────────────────────────────────── */

const AGG = '0x65863e5e0B2c2968dBbD1c95BDC2e0EA598E5e02';
const CID = 'QmZ2BgPsmnn4T4ShbdryoTWXFM4nHt7tM674fU4CLVHthH';
const JOB = 128;
const ALPHA = 500;
const FEE = ethers.parseUnits('0.01', 18);
const BASE = ethers.parseUnits('0.000001', 18);
const SCALE = 5;
const GAS = 3_000_000n;
const DELAY = 20_000; // poll every 20 s

/* ──────────────────────────────────────────────────────────────────── */

(async () => {
  const [signer] = await ethers.getSigners();
  const abi = (await hre.artifacts.readArtifact('ReputationAggregator')).abi;
  const agg = new ethers.Contract(AGG, abi, signer);

  /* send request */
  const tx = await agg.requestAIEvaluationWithApproval(
    [CID], '', ALPHA, FEE, BASE, SCALE, JOB, { gasLimit: GAS }
  );
  
  console.log('tx:', tx.hash);
  const rcpt = await tx.wait();
  const aggId = rcpt.logs
    .map(l => { try { return agg.interface.parseLog(l); } catch {} })
    .find(l => l?.name === 'RequestAIEvaluation').args.aggRequestId;
  console.log('aggId:', aggId);

  /* poll until done */
  while (true) {
    const [scores, justif, has] = await agg.getEvaluation(aggId);
    if (has && scores.length) {
      console.log('scores:', scores.map(s => s.toString()).join(', '));
      console.log('justifications CID:', justif);
      break;
    }
    if (await agg.isFailed(aggId)) {
      console.log('request failed');
      break;
    }
    await new Promise(r => setTimeout(r, DELAY));
  }
})();
```

This script initiates the Verdikta process analyzing your query. It takes a few minutes to return with a consensus ranking of the two options presented (True or False for P=NP) and a CID that can be used to look up the justification for the ranking. Using a Web browser, you can see the content of this CID using a publicly available IPFS node like `https://ipfs.io/ipfs/CID`, `https://dweb.link/ipfs/CID`, or `https://gateway.pinata.cloud/ipfs/CID`. If you want to get the content without a Web browser, you can use curl: `curl "https://ipfs.io/ipfs/CID"`, or ipfs, if installed: `ipfs get CID`. In all these cases, swap in your actual CID to replace the "CID" placeholder.

### Funding and Submitting a Request from a Smart Contract - Solidity Example

The verdikta system can also be called from a smart contract. Given below is a Solidity example of a contract that does this. This contract must be funded with LINK that it uses when called to pay for a Verdikta query.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IReputationAggregator {
    function requestAIEvaluationWithApproval(
        string[] calldata cids,
        string calldata addendum,
        uint256 alpha,
        uint256 maxOracleFee,
        uint256 estimatedBaseFee,
        uint256 maxFeeScaling,
        uint64 jobClass
    ) external returns (bytes32);
    
    function getEvaluation(bytes32) external view returns (uint64[] memory, string memory, bool);
    function isFailed(bytes32) external view returns (bool);
}

contract DemoClient {
    IReputationAggregator public immutable agg;
    IERC20 public immutable link;
    string[] private cids;
    bytes32 public currentAggId;
    bool internal linkApproved;

    event Requested(bytes32 id);
    event Result(bytes32 id, uint64[] scores, string justif);

    constructor(address aggregator, address linkToken) {
        agg = IReputationAggregator(aggregator);
        link = IERC20(linkToken);
        cids.push("QmSnynnZVufbeb9GVNLBjxBJ45FyHgjPYUHTvMK5VmQZcS");
    }

    // Function to approve aggregator (call this once before using request)
    function approveAggregator() external {
        link.approve(address(agg), type(uint256).max);
        linkApproved = true;
    }

    function request() external {
        require(currentAggId == bytes32(0), "already pending");
        
        // one-time unlimited approval from this contract to aggregator
        if (!linkApproved) {
            link.approve(address(agg), type(uint256).max);
            linkApproved = true;
        }

        currentAggId = agg.requestAIEvaluationWithApproval(
            cids, "", 500, 1e16, 1e12, 5, 128
        );
        emit Requested(currentAggId);
    }

    function publish() external {
        (uint64[] memory s, string memory j, bool has) = agg.getEvaluation(currentAggId);
        if (has) {
            emit Result(currentAggId, s, j);
            currentAggId = bytes32(0);
        } else if (agg.isFailed(currentAggId)) {
            currentAggId = bytes32(0);
        } else {
            revert("not ready");
        }
    }
}
```

After deploying this contract (using a tool like Hardhat), you would need to ensure that the deployed contract has enough LINK to pay for a request. Verdikta uses LINK to pay its arbiters. The contract function it uses is `requestAIEvaluationWithApproval()`, which pulls tokens from your account (hence requiring prior approval). We define `IERC20` to interact with the token used for payment (e.g., LINK token contract).

## Operation Details

### Random Selection of Arbiters

When you submit a request, the Verdikta contracts must choose which arbiters (oracles) will evaluate it. The choice has to be fair and unpredictable, otherwise a malicious party could try to steer sensitive cases to "friendly" arbiters.

Verdikta achieves this in two steps:

1. **Build a pool of eligible arbiters**  
   An arbiter is eligible if it is active, not blocked, supports the requested class, and its LINK fee ≤ maxFee.

2. **Run a weighted-random draw**  
   For every eligible arbiter *i* the contract computes a weight as follows:

   $$w_{i} = \text{clamp}\left( \frac{(1000 - \alpha)Q_{i} + \alpha T_{i}}{1000},1,400 \right) \cdot \text{clamp}\left( \frac{F_{\max} - \beta}{\text{fee}_{i} - \beta},1,S_{\max} \right)$$

   This weight is made by clamping a quality score between 1 and 400 and clamping a fee-based score between 1 and *S~max~* then taking the product of those two. The user specifies timeliness-versus-quality weight parameter α, max scaling parameter S~max~, base cost parameter β, and max fee parameter F~max~ when making the query request. *Q~i~* is the running quality score for arbiter *i*, *T~i~* is the running timeliness score for arbiter *i*, and *fee~i~* is the fee requested by arbiter *i*.

After computing all weights, the contract performs a roulette-wheel draw---each arbiter's probability is

$$P_{i} = \frac{\text{w}_{i}}{\sum\text{w}_{j}}$$

The random seed used in the roulette wheel mixes (a) entropy that aggregators pushed in previous blocks, (b) the chain's `block.prevrandao`, (c) the current timestamp, and (d) an ever-increasing counter---making the selection unpredictable and MEV-resistant on chains such as Base.

### Reputation Tracking

Verdikta keeps two numeric scores for every arbiter (operator-contract/job-ID pair):

| **Counter**        | **What it measures**                          | **Typical range**           |
|-------------------|----------------------------------------------|----------------------------|
| **Quality Score** | How closely the arbiter's answers line up with the consensus cluster | grows or shrinks in steps of ±4 |
| **Timeliness Score** | How reliably the arbiter delivers answers on time | grows or shrinks in steps of +4 or -2 |

These scores are updated through the `ReputationKeeper.updateScores()` call that the Aggregator triggers for each evaluation phase. The table below shows exactly what happens in each situation:

| **Event** | **Quality Change** | **Timeliness Change** | **Effect on tokens / status** |
|-----------|-------------------|---------------------|-------------------------------|
| Commit → Reveal → answer chosen & inside the best-match cluster | +4 | +4 | Arbiter also receives a LINK *bonus* (fee × bonusMultiplier) |
| Commit → Reveal → answer chosen but *outside* the cluster | -4 | 0 | No bonus; quality penalty |
| Commit → Reveal → answer submitted but *not* chosen (another answer matched the cluster first) | 0 | -2 | No bonus; timeliness penalty |
| Commit received, but arbiter never reveals (reveal timeout) | 0 | -2 | No bonus; timeliness penalty |
| Oracle was polled but never committed (commit timeout) | 0 | -2 | No bonus; timeliness penalty |

Punishment for unfavorable scoring are the following:

- Score drops below mildThreshold (-20): Arbiter is locked for lockDurationConfig (default 24 h); no slash
- Score drops below severeThreshold (-60): Arbiter is locked (default 24 h) and loses slashAmountConfig of VDKA stake (default 0)
- Persistent decline over maxScoreHistory (25) snapshots: Same slash + lock as severe case; recentScores reset

### Decentralization and Robustness

Because of the combination of random selection, staking, and reputation:

- No single arbiter or small group can unduly influence results (they never know which requests they'll get, and even if one is corrupt or buggy, the others will outvote them).

- The network is tolerant to some arbiters being down or behaving poorly; the worst that happens is those arbiters lose rep/stake and are financially disincentivized from repeating it. The final results remain trustworthy as long as a majority (or a quorum) of arbiters per request are honest. This assumption is similar to many Byzantine fault tolerant systems, where the protocol works correctly if, say, 2 out of 3 oracles are honest.

- Users can trust that there's a strong economic force incentivizing honesty. If Verdikta arbiters as a whole started acting wrong, they'd be burning their own stake and reputation, which in an efficient market, rational actors would not do unless they stood to gain more by cheating than they lose by slashing (which Verdikta's design pushes against).

### Transparency and Community Oversight

Verdikta's use of Ethereum and Base means that all of these actions are transparent. The addresses of arbiters, their stakes, their reputation scores (if stored on chain), and their responses (the scores and IPFS hashes they submit) are publicly visible. This transparency lets the community audit Verdikta. If an arbiter is behaving oddly, everyone can see it. If the selection randomness were somehow failing, it'd be evident on-chain. This open data builds trust that Verdikta operates as advertised.

### Reading Results On-Chain

The Verdikta Reputation Aggregator contract stores the final results in a mapping and emits them in an event. Ways to retrieve results include the following:

• **View function:** call `getEvaluation(aggId)` (alias `evaluations`) to obtain the aggregated score array and a comma-separated string of justification CIDs. This is convenient for off-chain calls (e.g., from your front-end or script). For example, `aggregator.getEvaluation(aggId)` might return `([85,15], "QmX...abc,QmY...def")`, meaning scores of 85 and 15 and two IPFS CIDs for the clustered oracles' justifications.

• **Events:** a `FulfillAIEvaluation` event is emitted when an evaluation finalizes. Its parameters include the aggregation ID, the aggregated score array, and the combined CID string. Events are logged on-chain and can be watched by off-chain services; if you listen for this event you can capture the result without making a function call.

### Understanding the Aggregated Score

The aggregated score is a numerical representation of the AI evaluation outcome. Its meaning depends on your use case, perspective, or how you formulated the query:

- It could be a probability or confidence (e.g., "score 85 means an 85% confidence that the claim is true").

- It could be a rating on a scale (say 0 to 100, where 100 means "strongly yes" and 0 means "strongly no", or some similar interpretation).

- It might correspond to specific outcomes (for instance, perhaps 0 means Party A wins the dispute, 100 means Party B wins, and 50 means tie or inconclusive).

Verdikta and the query define how to interpret the score. It's important that as a developer, you use this score correctly in your application. For example, if Verdikta is used in an escrow contract to decide who gets the funds, you might say: if score > 50, winner is Seller; if score < 50, winner is Buyer.

Because the score is aggregated from multiple arbiters, it is generally a more robust metric than a single AI's output. If all arbiters give roughly the same answer, the score is essentially that answer. If they vary, the score is somewhere in between. By design, Verdikta gives you the one final score so you usually won't need to worry about internal disagreements -- the system takes care of that for you.

### Fetching and Using Justification CIDs

Verdikta's added value over a simple numeric oracle is that it provides justifications for transparency. The result includes one or multiple IPFS CIDs where the reasoning is stored. These are pointers to off-chain data that you (or users of your dApp) can retrieve to see *why* the AI came to the conclusion it did.

To use the CIDs:

1. Choose an IPFS gateway or IPFS node to fetch from. If you have ipfs installed or are using a service like Infura, Pinata, or Cloudflare's IPFS gateway, you can input the CID to get the content. For example, if a justification CID is `QmY...def`, you could use a gateway URL like `https://ipfs.io/ipfs/QmY...def` or `https://gateway.pinata.cloud/ipfs/QmY...def` in a browser. Many gateways exist; developers might use an IPFS HTTP client in code to fetch the JSON/text.

2. The content you get back is typically a text explanation (possibly structured text or JSON). It might read like: *"The AI determined that Party A breached the contract because the evidence X clearly shows... and according to clause Y, Party A is liable. Therefore, Party B should win the dispute."* This is immensely helpful for human verification. Your application could display this explanation to users to increase trust in the automated decision.

3. If multiple CIDs are returned (say two justifications from two arbiters), you can retrieve all of them. They might be very similar if all AIs agreed, or there might be subtle differences in phrasing or even perspective. Perhaps one justification provides a bit more detail on one aspect, while another adds a different viewpoint. As a developer, you could show these to the end-user.

**Gas and Storage Consideration:** The justifications are *not stored on-chain*---only their CIDs are. This is by design to keep gas costs reasonable. Storing large text on Ethereum (or any chain) is very expensive. IPFS offloads that storage. The trade-off is that retrieving justifications requires off-chain action (which is fine, since it's mostly for human reading or off-chain processes). The score, however, being on-chain, can be used by other contracts directly. For example, your smart contract could automatically do something if the score exceeds a threshold, all in one transaction, because it can call Verdikta's contract to get the score within its execution. It can't, of course, understand the IPFS justification text on-chain -- that's purely for off-chain transparency and user information.

## Verdikta Direct Interaction Portal

While the focus of this guide is programmatic integration, it's worth mentioning the Verdikta Direct Interaction website -- a front-end tool provided by the Verdikta team for experimentation and user convenience. This web portal offers a user-friendly interface to test Verdikta without writing any code.

On the Verdikta Direct Interaction site, you can:

- **Submit Natural Language Queries:** If you have a question or a dispute description, you can simply type it into the interface (for example, paste a scenario or a prompt). The site uploads your input to IPFS (turning it into a CID) -- essentially *"CID-ifying"* your natural language input -- and then call the Verdikta contract on your behalf. This is great for quickly trying out Verdikta's capabilities or demonstrating it to non-developers. You don't need to manually deal with IPFS; the site handles it.

- **Provide Existing CIDs:** If you already have data on IPFS (maybe you prepared a JSON file with all necessary info), you can provide the CID directly. The site can use that to call the contract, skipping the upload step.

- **Manage Funding:** The site connects to a web3 wallet (MetaMask) so you can approve tokens and pay the fee through a simple UI. The site guides you to approve the spending of tokens and then trigger the transaction for `requestAIEvaluationWithApproval()`.

- **View Results:** After the request is processed, the site displays the aggregated score and fetches the justifications for you. It might show the result in a user-friendly way, for example: "Outcome: 85/100 in favor of Party B" and then the text explanations below it. This saves you the trouble of manually using an IPFS gateway.

The Verdikta Direct Interaction portal essentially wraps all the steps we've described in a nice UI. It's ideal for learning and for stakeholders to play with Verdikta. However, for integration into your own project, you'd use the programmatic approach (Solidity/JavaScript) as described above. The portal can also serve as a reference -- you might inspect the browser console or network calls to see how exactly it's interacting with the contract.

## Conclusion

Verdikta enables a new class of smart contract applications by providing trustless AI evaluations on-chain. By combining blockchain technology, decentralized agents, and AI, it allows developers to create contracts that can make complex judgments or assessments in an automated yet trustworthy manner. In this document, we covered how Verdikta works and how to use it:

- We reviewed how smart contracts, Chainlink, and IPFS support Verdikta's infrastructure.

- We explained Verdikta's trustless AI approach, using multiple AI arbiters to ensure no single point of failure or trust.

- We went through the mechanics of submitting a request via the Aggregator contract, including funding the request and calling `requestAIEvaluationWithApproval()`.

- We provided code snippets in Solidity and JavaScript to illustrate integration---from approving tokens to calling the contract and retrieving results.

- We covered the selection of arbiters, showing how Verdikta provides fair randomness to pick arbiters and how staking and reputation incentivize honest behavior, keeping the system secure and robust.

- We showed how to read the results (score and justification CIDs) and what to do with them, emphasizing the benefit of having human-readable explanations stored on IPFS alongside the numeric outcome.

- Finally, we mentioned the Verdikta Direct Interaction web portal for easy experimentation.

With this knowledge, you should be well-equipped to onboard Verdikta into your project. Whether you're building a decentralized dispute resolution platform, a content curation DAO that needs AI moderation, or any DApp that could use impartial AI judgments, Verdikta provides the tools to do it in a decentralized way. Integrating AI into smart contracts is cutting-edge, and by using Verdikta, you're at the forefront of marrying AI and blockchain. The Verdikta community and team are eager to support developers, so be sure to reach out, read the official docs for any updates, and perhaps even contribute feedback or improvements.

Happy coding, and welcome to the world of trustless AI-powered smart contracts!
