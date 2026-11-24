// Every user-facing string of the client, in one place so the wording rule can be checked.
// Placeholders are {name}; fill() puts values in. No string here is built from parts.
import { DISCLOSURE_KEY_NOTE } from '@verdikta/stake-attestation-shared/disclosure-key';
import { INTEGRITY_NOTE } from '@verdikta/stake-attestation-shared/execution-evidence';
import { LISTING_WARNING } from '@verdikta/stake-attestation-shared/listing-warning';
import { STAKE_DOCUMENTS_NOTE } from '@verdikta/stake-attestation-shared/stake-documents';

/** The control proof file's content (docs/control-proof.md), for the {format} placeholders. */
export const CONTROL_FILE_FORMAT = '{"version":1,"maker":"<address>"}';

export const STRINGS = {
  // the site's name, as "Verdikta Bounties" is the bounty site's (owner, 2026-11-16); what it is stays under it
  appName: 'Verdikta Verifiers',
  tagline: 'Stake attestation',
  taglineOn: '{tagline} · {network}',
  // the network the build is for, by its chain id (VITE_SA_CHAIN_ID)
  networks: { 84532: 'Base Sepolia', 8453: 'Base', 31337: 'Local network' },
  // every listing page, and the hunter tool (node P5): shared/src/listingWarning.js
  warning: LISTING_WARNING,
  nav: {
    home: 'Home',
    feed: 'Feed',
    record: 'Records',
    list: 'List a version',
    check: 'Check a disclosure',
    claim: 'Claims',
  },
  home: {
    headline: 'Code with a stake behind it',
    seeFeed: 'See the feed',
    // under the hero's buttons: three facts of the design, none of them a promise about the code
    points: {
      escrow: 'Stake held in escrow on-chain',
      judged: 'Judged by the Verdikta arbiter network',
      record: 'A public record for every artifact hash',
    },
    // How it works, for each side. A step's text is a sentence this file already has wherever one fits
    // (test/strings.test.js holds those to their source); the others say no more than those do.
    how: {
      title: 'How it works',
      makers: {
        title: 'For makers',
        steps: [
          {
            title: 'List a version',
            text: 'Name the version you stake, what is in scope, what each class of finding pays and the windows a claim runs through.',
          },
          {
            title: 'Fund and open',
            text: 'The server builds and validates the environment before anything goes on-chain; then your wallet lists the version and funds the escrow.',
          },
          {
            title: 'Show the badge',
            text: 'The badge shows the live state of the stake on this hash. It changes with the record and ends when the stake ends.',
          },
          {
            title: 'Answer claims',
            text: 'Check the disclosures hunters send you, then release, roll forward to a fixed version, or dispute, from a claim or listing page.',
          },
        ],
      },
      hunters: {
        title: 'For hunters',
        steps: [
          {
            title: 'Pick a listing',
            text: 'The feed lists every listing that takes claims: hash, image, scope, award table, bond, windows, days open, claims so far and escrow remaining.',
          },
          {
            title: 'Prove the bug',
            text: 'Find a bug inside the listing\'s scope and prove it with a runnable test.',
          },
          {
            title: 'Commit and disclose',
            text: 'Commit two hashes on-chain, then disclose the encrypted archive. The staker named on the listing reads it first, through the fix window.',
          },
          {
            title: 'Reveal and be judged',
            text: 'A claim is judged in minutes once its fix window ends, awards are paid on-chain, and a bond, not a ban, prices invalid claims.',
          },
        ],
        note: 'Hunters claim with the command-line tool verdikta-attest, not in the browser. Autonomous hunters are welcome.',
      },
    },
    lead:
      'A maker stakes funds behind one version of their code. A hunter who proves a bug in it ' +
      'with a runnable test is paid from the stake, once the Verdikta arbiter network has run ' +
      'the proof and judged it.',
    recordNote:
      'The record states what was staked and what the arbiters found. It is not a guarantee ' +
      'that the code has no bugs.',
    status:
      'The feed lists every stake that takes claims, and each artifact hash has a public record. Makers list a ' +
      'version, check the disclosures hunters send them, and release, roll forward or dispute from a claim or listing page.',
  },
  // node P27: what an agent reads first, served at the site's root from client/public
  footer: {
    lead: 'For agents:',
    guide: '/agents.txt',
    indexLead: 'index',
    index: '/llms.txt',
  },
  // the button beside a hash, an address or a command: its name for a screen reader, never drawn
  copy: {
    label: 'Copy: {what}',
    command: 'Copy the command',
    done: 'Copied',
  },
  wallet: {
    connect: 'Connect wallet',
    connecting: 'Connecting…',
    connected: 'Wallet {account}',
    none: 'No browser wallet was found. Install one to list, fund or flag.',
    wrongChain: 'Your wallet is on chain {actual}; this site works on chain {expected}. Switch networks and connect again.',
    notConfigured: 'This site has no contract configured (VITE_SA_CONTRACT, VITE_SA_CHAIN_ID).',
    rejected: 'The wallet did not send it: {reason}',
  },
  listing: {
    title: 'List a version',
    intro:
      'Name the version you stake, what is in scope, what each class of finding pays and the ' +
      'windows a claim runs through. The server builds and validates the environment before ' +
      'anything goes on-chain; then your wallet lists the version and funds the escrow.',
    sections: {
      artifact: 'Artifact',
      scope: 'Scope',
      documents: 'Documents',
      awards: 'Award table',
      bond: 'Hunter bond',
      windows: 'Windows',
      allowlist: 'Invited hunters',
      knownIssues: 'Known issues',
      valueAtRisk: 'Value at risk',
      environment: 'Build and test commands (Foundry)',
      disclosure: 'Disclosure key',
    },
    fields: {
      kind: 'Artifact kind',
      kindRepo: 'Repository',
      kindContract: 'Deployed contract',
      repo: 'Repository URL',
      baseCommit: 'Commit',
      address: 'Contract address',
      chainId: 'Chain id',
      scopeInclude: 'In scope (one glob per line)',
      scopeExclude: 'Out of scope (one glob per line)',
      documents: 'Where the code\'s requirements are written (one glob per line, at most 16; optional)',
      award: '{class} award (ETH)',
      lowestClassCounted: 'Lowest class counted',
      bond: 'Hunter bond (ETH)',
      fixWindowDays: 'Fix window (days)',
      disputeWindowHours: 'Dispute window (hours)',
      disclosureGraceHours: 'Disclosure grace (hours)',
      revealWindowDays: 'Reveal window (days)',
      allowlist: 'Hunter addresses (one per line; empty: open to every hunter)',
      valueAtRiskUsd: 'Declared value at risk (USD, optional)',
      setup: 'Setup command',
      build: 'Build command',
      test: 'Test command',
      testFiles: 'Command that runs named test files ($FILES)',
      testIds: 'Command that runs named tests ($TEST_IDS)',
      lint: 'Lint command (optional)',
      testPaths: 'Where a proof of concept may add tests (one glob per line)',
      protectedPaths: 'Paths reset before every run (one glob per line)',
    },
    hints: {
      // tester bounty 400, the maker review (C1): the builder and the site read the repository with no credentials
      // (builder/src/git.js, shared/src/controlProof.js repoUrlCheck), and a hunter clones it
      repo:
        'The https address of a public repository, in the form https://host/owner/name, on a git host this site reads: ' +
        'a listing on another host is refused. The site reads the listed commit with no credentials, and hunters ' +
        'clone it to work.',
      awards:
        'Awards never decrease with severity, and every class from the lowest counted up pays more than 0. ' +
        'The escrow must hold at least the CRITICAL award. A valid finding below the lowest class counted is ' +
        'published on the record and gets its bond back, with no award.',
      // C2: ClaimRules.awardFor pays 0 below lowestClassCounted, whatever the table holds there
      awardNotCounted: 'Below the lowest class counted: pays nothing, whatever is entered here.',
      bond: 'Each hunter posts this bond with a claim. An invalid claim forfeits it to you.',
      windows:
        'Defaults: a 14-day fix window (30 for a deployed contract), a 72-hour dispute window, ' +
        'a 48-hour disclosure grace and a 7-day reveal window. A 0-day fix window is allowed.',
      // C3: what each window controls, by the contract's own rules (ClaimLogic disclose, release, dispute, appeal,
      // flagBadDisclosure, reveal and expire)
      windowLines: {
        fixWindowDays:
          'Fix window: from the moment a hunter discloses a claim to you, your time to fix before the hunter may ' +
          'reveal it. You can release a claim sooner.',
        disputeWindowHours:
          'Dispute window: from a verdict, your time to dispute a valid one, and the hunter\'s time to appeal an ' +
          'INVALID. Until it ends a valid verdict you have not disputed does not pay, only the hunter can settle an ' +
          'INVALID that is not appealed, and no confirmation round starts.',
        disclosureGraceHours:
          'Disclosure grace: from a disclosure, your time to flag it as bad, when it cannot be fetched or is not the ' +
          'committed archive. The record shows the flag.',
        revealWindowDays:
          'Reveal window: once a claim may be revealed, its fix window over and every earlier claim on the listing ' +
          'settled or expired, the hunter\'s time to reveal it. After that anyone may expire it, and its bond goes to ' +
          'you. It is also the hunter\'s time to send a round again after one that ended with no verdict, and, from the ' +
          'end of the dispute window, how long an award that awaits a confirmation waits for one.',
      },
      allowlist: 'An invited listing is shown on the record as invited.',
      // owner, 2026-11-10 (Q73 #5): a listed root cause is DUPLICATE whatever the entry says; no bug at all is NatSpec
      knownIssues:
        'Known issues are public and fixed at listing. A claim whose root cause is one of them settles DUPLICATE (the ' +
        'hunter\'s bond back, no award), whatever the entry says about why: an entry that calls the behaviour intended or ' +
        'accepted is a known issue all the same.',
      knownIssuesIntended:
        'To mark a behaviour as no bug at all, leave it off known issues and document it as intended in the code (NatSpec) ' +
        'or in a listing document (Documents, above): a claim about it then falls under INVALID.',
      // owner decision Q61 (a): the field common takes; the runner adds the files to the jurors' context pack
      documents:
        'Name the files where your code\'s requirements are written: the README, specs, interface docs, such as README.md ' +
        'or docs/**. The jurors read them, from the listed commit, right after the source a claim names, to see what the ' +
        'code is required to do. ' + STAKE_DOCUMENTS_NOTE + ' The validation report lists the files they would read.',
      // node P35 (claim test, item 6): what the jurors have when no listing document states a requirement
      requirementsDocument:
        'We recommend a document that states your code\'s requirements: what each function must do, and what it must ' +
        'never allow. Commit it at the version you list and name it here. Without one, the jurors judge what the code is ' +
        'required to do from the source files a claim names, their comments and interfaces, and the claim\'s own argument.',
      valueAtRisk: 'A declaration the record shows beside the stake, in whole dollars.',
      control:
        'Every listing needs the project\'s proof, with no exception. Commit .verdikta/stake-control.json holding {format} ' +
        'with the address of the wallet that will list, in the version you list, on a branch or tag of the repository. ' +
        'One address only: a sponsor can stake if the project names its wallet there. A deployed contract also needs a ' +
        'signature from its deployer or current owner. Without these the builder refuses the listing.',
    },
    bounds: {
      wholeNumber: 'Enter a whole number.',
      fixWindow: 'The fix window is 0 to 90 days.',
      disputeWindow: 'The dispute window is 24 to 2160 hours (90 days).',
      grace: 'The disclosure grace cannot be longer than the fix window.',
      revealWindow: 'The reveal window is 3 to 90 days (at least 72 hours).',
      amount: 'Enter an amount in ETH, such as 0.4.',
    },
    // each line of the documents field common refuses, by common's code (lib/documents.js)
    documentIssue: 'Line {line} ({entry}): {code}: {text}',
    documentCodes: {
      STAKE_DOCUMENT_OUTSIDE_REPOSITORY: 'a document is a file of the listed commit, named by its path from the repository root: no leading "/" and no ".." segment.',
      STAKE_DOCUMENT_NOT_PLAIN: 'write the path as git lists it: no "." or empty segment, no leading "./" or trailing "/", no backslash.',
      STAKE_DOCUMENT_GLOB_INVALID: 'a glob is 1 to 512 characters with no whitespace.',
      STAKE_DOCUMENT_DUPLICATE: 'the same as an earlier line; name each glob once.',
      tooMany: 'At most {max} documents.',
    },
    knownIssues: {
      add: 'Add a known issue',
      remove: 'Remove this issue',
      legend: 'Known issue {n}',
      title: 'Title',
      class: 'Class',
      paths: 'Paths (one per line)',
      description: 'Description',
      id: 'Id: {id}',
      none: 'No known issues: a valid claim on anything in scope is paid.',
    },
    needKey: 'Generate or enter a disclosure key, and save its private half, before you validate.',
    needSignature: 'A deployed contract needs its deployer\'s or owner\'s signature before you validate.',
    needWallet: 'Connect the wallet that will list this version: the project names its address, and it signs the listing request.',
    signing: 'Waiting for your wallet to sign the listing request…',
    refusal: 'Refused: {code}: {detail}',
    proof: {
      title: 'The deployment\'s signature',
      intro:
        'The deployment\'s current owner or its deployer signs the message below (EIP-191 personal_sign; a contract owner ' +
        'answers through EIP-1271). A deployer also gives the transaction that created the contract. The message names ' +
        'your wallet, this artifact and this site, so a signature counts for that only.',
      get: 'Show the message to sign',
      getting: 'Asking the server…',
      stale: 'The artifact or the wallet changed: show the message again.',
    },
    fixFirst: 'Before you validate, complete: {fields}.',
    submit: 'Validate through the server',
    submitting: 'Sending the listing to the server…',
    refusedTitle: 'The server refused the listing',
    refusedIntro: 'Nothing was built. Fix these and validate again:',
    networkError: 'The server could not be reached: {reason}',
    busy: 'Every build slot is taken. Try again in a few minutes.',
    status: 'Validation: {status}',
    statuses: {
      queued: 'waiting for a build slot',
      checking: 'checking the project\'s proof at the listed commit',
      building: 'building and validating the environment',
      awaiting_approval: 'waiting for a reviewer to approve the signature',
      signing: 'signing the listing',
      pinning: 'pinning the listing and dispute archives',
      ready: 'ready to list',
      refused: 'refused by the builder',
      error: 'stopped by an error',
    },
    jobError: 'The listing was not issued: {code}: {detail}',
    again: 'Edit and validate again',
  },
  key: {
    intro:
      'Hunters encrypt their findings to this key, so only you can read a claim before it is ' +
      'revealed. It is a dedicated age key, never your wallet key.',
    generate: 'Generate a disclosure key in this browser',
    useOwn: 'Use an age key I already have',
    ownRecipient: 'Your age public key (age1…)',
    ownInvalid: 'This is not an age X25519 public key: {reason}',
    ownIsPrivate: 'That is a private key. Enter the age1… public key; the private key stays with you.',
    recipient: 'Public key (listed)',
    // node P35: the key in both its forms, whatever form it was entered in (disclosure.line follows, then the note)
    forms: 'The listing\'s key in both its forms:',
    identity: 'Private key',
    shownOnce:
      'Shown once. It is never sent to the server or anywhere else, and this site keeps no copy: ' +
      'not on the server, not in the browser. Without it you cannot read the disclosures hunters send you.',
    download: 'Download the key file',
    saved: 'I have saved the private key',
    gone: 'The private key is no longer on this page. Keep your copy; this site cannot show it again.',
    replace: 'Generate a different key',
  },
  report: {
    title: 'Validation report',
    status: 'Builder status: {status}',
    steps: 'Steps',
    step: '{name}: {status}',
    stepNames: {
      spec: 'Spec checked',
      control: 'The project\'s proof checked at the listed commit',
      fetch: 'Repository fetched at the commit',
      documents: 'Documents chosen at the listed commit',
      build: 'Environment image built',
      size: 'Image size checked',
      push: 'Image pushed',
      registry: 'Image pulled back by digest',
      verifiedSource: 'Deployed code matched to the repository',
      listingCheck: 'Build, suite and harness checked on the code-runner',
      finalSpec: 'Final spec written',
    },
    image: 'Image: {ref}',
    refusals: 'Why the builder refused',
    warnings: 'Warnings',
    error: 'Error: {code}: {detail}',
    attestation: 'Attestation signed ({trust} trust, key {keyId})',
    devTrust: 'Signed with a development key: arbiters accept it only on a development network.',
    limits: 'Sandbox limits: {limits}',
    none: 'The builder has not reported yet.',
    // node P20: the builder's documents step, as the runner would choose them for a claim
    documentsTitle: 'Documents the jurors would read',
    documentsIntro: 'Chosen from the listed commit with the arbiters\' own selection, in the order the jurors read them. A file a claim names in scope is read with the source instead.',
    documentsRead: 'Read: {files}',
    documentsPastCap: 'Past the 32-file cap, left out: {files}',
    documentsSkipped: 'Skipped: {files}',
    documentsUnmatched: 'Matches no file: {globs}',
    documentsNone: 'none',
    documentsSkippedFile: '{path} ({reason})',
    documentsReasons: {
      symlink: 'a symbolic link',
      submodule: 'a submodule',
      notAFile: 'not a regular file',
      tooLarge: 'over 1,000,000 bytes',
      notText: 'not UTF-8 text',
      notAskable: 'a path with a line break',
    },
  },
  chain: {
    readyTitle: 'Ready to list',
    listingCid: 'Listing archive: {cid}',
    disputeCid: 'Dispute archive: {cid}',
    artifactHash: 'Record key: {hash}',
    terms: 'Terms list() stores',
    awards: 'Awards: LOW {LOW}, MEDIUM {MEDIUM}, HIGH {HIGH}, CRITICAL {CRITICAL} ETH',
    bond: 'Bond: {bond} ETH',
    windows: 'Windows: fix {fix} days, dispute {dispute} hours, grace {grace} hours, reveal {reveal} days',
    allowlist: 'Invited hunters: {count}',
    open: 'Open to every hunter',
    knownIssues: 'Known issues: {count}',
    valueAtRisk: 'Declared value at risk: {usd} USD',
    // errata E8 and E9: the two values list() copied from the program when the listing was made
    band: 'Narrow INVALID band: an INVALID with at least {floor} of 1,000,000 ({points} points) of valid mass gets its bond back, with no award',
    bandEmpty: 'Narrow INVALID band: empty, so every INVALID forfeits its bond to the maker',
    size: 'Confirmation size: an award above {size} ETH waits for the dispute panel to confirm it before it pays, the round paid from the escrow',
    sizeAll: 'Confirmation size: 0, so every counted award waits for the dispute panel to confirm it before it pays, the round paid from the escrow',
    mismatch: 'The server\'s list() arguments differ from what you entered ({fields}). Nothing was sent; validate again.',
    list: 'List on-chain',
    notTheMaker: 'Nothing was sent: this listing was built for {maker}, the wallet the project names, and your wallet is {account}. From another wallet it would not count. Switch back and list again.',
    listing: 'Sending list()…',
    listed: 'Listing {id} created (transaction {tx}).',
    escrow: 'Escrow (ETH, at least the CRITICAL award)',
    escrowLow: 'The escrow must be at least the CRITICAL award, {min} ETH.',
    fee: 'Listing fee for the first 30 days: {fee} ETH',
    fund: 'Fund and open',
    funding: 'Sending fund()…',
    opened: 'Listing {id} is open until {until} (transaction {tx}).',
    openedNoTime: 'Listing {id} is open (transaction {tx}). Its page shows until when.',
    fundLater: 'If you leave this page before funding, fund the listing from its own page:',
    fundPage: 'Listing {id}',
    // tester bounty 400, the maker review (C4): once it is open, where the listing is managed
    managePage: 'The listing is managed from its own page, where its claims appear and you top up the escrow, renew, roll forward or close:',
    existingListed: 'You already listed this version as listing {id}, and it is not funded yet. A version has one listing per maker until it is closed: fund that one, with its own terms, from its page:',
    existingActive: 'You already have listing {id} for this version ({state}). A version has one listing per maker until it is closed.',
    failed: 'The transaction failed: {reason}',
  },
  fund: {
    title: 'Listing',
    intro: 'A listing opens once its maker funds it: the listing fee for the first 30 days and an escrow of at least the CRITICAL award.',
    listingId: 'Listing id',
    load: 'Load the listing',
    loading: 'Reading the listing…',
    notFound: 'There is no listing {id}.',
    readFailed: 'The listing could not be read: {reason}',
    retry: 'Read again',
    summary: 'Listing {id}',
    maker: 'Maker',
    state: 'State',
    listingCid: 'Listing archive',
    disclosureKey: 'Disclosure key',
    notMaker: 'Only the listing\'s maker ({maker}) can fund it; your wallet is {account}.',
    alreadyOpen: 'Listing {id} is open until {until}.',
    notFundable: 'Listing {id} is {state}: there is nothing to open here.',
    changed: 'Nothing was sent: listing {id} on the site\'s chain is not the one this page shows, or it is no longer waiting to open (it is {state}). Reload the page.',
    states: { Listed: 'listed, not funded', Open: 'open', Depleted: 'depleted', Rolled: 'rolled forward', Closed: 'closed' },
  },
  check: {
    title: 'Check a disclosure',
    intro:
      'A hunter who claims a bug commits two hashes on-chain, then discloses the encrypted archive. ' +
      'This page fetches it, checks it against the commitments and decrypts it with your private key, ' +
      'all in this browser. Your key is never sent anywhere.',
    claimId: 'Claim id',
    load: 'Load the claim',
    loading: 'Reading the claim…',
    notFound: 'There is no claim {id}.',
    readFailed: 'The claim could not be read: {reason}',
    retry: 'Read again',
    summary: 'Claim {id} on listing {listingId}',
    hunter: 'Hunter',
    committedAt: 'Committed',
    disclosedAt: 'Disclosed',
    graceEnds: 'Flag a bad disclosure until',
    cid: 'Encrypted archive',
    archiveHash: 'Committed archive hash',
    ciphertextHash: 'Committed ciphertext hash',
    flagged: 'Flagged as a bad disclosure',
    yes: 'yes',
    no: 'no',
    notDisclosed: 'The hunter has not disclosed this claim yet: there is nothing to fetch.',
    identity: 'Private key (AGE-SECRET-KEY-1…)',
    keyFile: 'Or load the key file',
    keyFileEmpty: 'The file holds no AGE-SECRET-KEY-1 line.',
    run: 'Fetch and check',
    running: 'Fetching and checking…',
    noGateway: 'This site has no IPFS gateway configured (VITE_IPFS_GATEWAY).',
    steps: {
      key: 'Your key is the listing\'s disclosure key',
      fetch: 'Encrypted archive fetched',
      ciphertext: 'Ciphertext hash matches the commitment',
      decrypt: 'Decrypted with your key',
      plaintext: 'Archive hash matches the commitment',
    },
    stepLine: '{name}: {result}',
    stepPassed: 'yes',
    stepFailed: 'no',
    stepSkipped: 'not reached',
    verdicts: {
      match: 'The disclosed copy is the committed archive. Nothing to flag.',
      bad: 'The disclosed copy is not the committed archive: {reason}',
      unavailable: 'The encrypted archive could not be fetched: {reason}. If it stays unavailable, you may flag the disclosure.',
      wrongKey: 'This private key is not the listing\'s disclosure key. That is not the hunter\'s fault: use the key you listed.',
      badIdentity: 'This is not an age private key: {reason}',
    },
    reasons: {
      ciphertext: 'the fetched ciphertext hashes to {actual}, not {expected}',
      decrypt: 'it does not decrypt with the listing\'s key ({code})',
      plaintext: 'the decrypted archive hashes to {actual}, not {expected}',
      tooLarge: 'it is larger than {max} bytes',
      http: 'the gateway answered {status}',
      network: 'the gateway could not be reached',
      cid: 'the disclosed CID is not a valid CID',
    },
    save: 'Save the decrypted archive',
    flag: 'Flag a bad disclosure',
    flagging: 'Sending flagBadDisclosure()…',
    flaggedNow: 'Flagged on-chain (transaction {tx}). The record shows the flag; the arbiters\' check at reveal decides.',
    alreadyFlagged: 'This claim is already flagged.',
    graceOver: 'The disclosure grace ended at {time}: a flag is no longer possible.',
    notMaker: 'Only the listing\'s maker ({maker}) can flag it; your wallet is {account}.',
  },
  // the site's server: the feed, the record mirror and the badge (node P4b1)
  site: {
    asOf: 'As of block {block}, {time}.',
    stale: 'The site\'s indexer is behind the chain ({reason}): events after block {block} may be missing.',
    unavailable: 'The site\'s server could not answer: {reason}',
    notConfigured: 'The site\'s server has no deployment configured.',
    retry: 'Read again',
  },
  // the project's proof on the record (nodes P8, P9; server/src/control/)
  control: {
    repository: 'Staker named by the repository',
    deployment: 'Staker controls the deployment',
    bothLines: 'Staker named by the repository, and controls the deployment',
    yes: 'yes',
    no: 'no',
    intro:
      'The project decides who may stake on it. A listing counts only with a builder\'s signature and the project\'s proof: a ' +
      'file in the repository, at the listed commit, naming the staker\'s wallet, which may be a sponsor\'s; for a deployed ' +
      'contract also a signature from its deployer or owner. Everything below can be checked without this site.',
    why: 'Why',
    proof: 'What it rests on',
    deploymentProof: 'What the deployment line rests on',
    lastCheckFailed: 'The last check gave no answer ({reason}); this stands from the check before it, and the site tries again.',
    fileAt: 'File {path} at commit {commit}, blob {blob}.',
    noFile: 'No file at {path} in commit {commit} was read.',
    fileNames: 'It names {address}; this listing\'s maker is {maker}.',
    fileNamesNothing: 'It names no address in the documented format.',
    onRefsYes: 'The commit is on the repository\'s own branch or tag {ref}.',
    onRefsNo: 'The commit is not on any of the repository\'s own branches or tags.',
    onRefsUnknown: 'Whether the commit is on the repository\'s own branches or tags is not known.',
    checked: 'Last checked {time}.',
    nextCheck: 'The site tries again at {time}.',
    recheck: 'To check it yourself (any ref printed by the second command holds the commit):',
    recheckClone: 'git clone --bare --filter=tree:0 {repo} check.git',
    recheckRefs: 'git -C check.git for-each-ref --contains {commit} refs/heads refs/tags',
    recheckFile: 'git -C check.git show {commit}:{path}',
    fileHowTo:
      'To prove control a commit holds {path} with {format} and is on a branch or tag of the ' +
      'repository. A commit cannot change, so a file added later needs a new version listed.',
    signer: 'Signed by {signer}, {role}.',
    roles: { owner: 'its current owner (owner() at the block below)', deployer: 'its deployer (the creation transaction below)' },
    contractSigner: 'The signer is a contract: its isValidSignature (EIP-1271) answers for the signature.',
    deploymentAt: 'Deployment {address} on chain {chainId}, read at block {block}.',
    creationTx: 'Creation transaction {tx}.',
    signature: 'Signature {signature}',
    messageLabel: 'The message to sign',
    messageSigned: 'The message signed',
    recheckDeployment: 'To check it yourself (save the message above as message.txt):',
    recheckSignature: 'cast wallet verify --address {signer} "$(cat message.txt)" {signature}',
    recheckContractSignature: 'cast call {signer} "isValidSignature(bytes32,bytes)(bytes4)" $(cast hash-message "$(cat message.txt)") {signature} --block {block} --rpc-url <chain {chainId}>',
    recheckOwner: 'cast call {address} "owner()(address)" --block {block} --rpc-url <chain {chainId}>',
    recheckDeployer: 'cast tx {tx} from --rpc-url <chain {chainId}>; cast receipt {tx} contractAddress --rpc-url <chain {chainId}>',
    formTitle: 'The deployment\'s signature',
    formIntro:
      'The deployment\'s current owner or its deployer signs the message below (EIP-191 personal_sign; a contract owner ' +
      'answers through EIP-1271). A deployer also gives the transaction that created the contract. The message names ' +
      'this maker, this artifact hash and this chain, so a signature counts for this listing\'s maker on this artifact only.',
    signerField: 'Signer address',
    signatureField: 'Signature (0x hex)',
    creationTxField: 'Creation transaction hash (a deployer only)',
    sign: 'Sign with the connected wallet',
    signing: 'Waiting for the wallet…',
    send: 'Send the proof',
    sending: 'Checking on the listing\'s chain…',
    refused: 'The proof does not count: {reason}',
  },
  // the contract's enums, as the record mirror names them
  enums: {
    listingStates: { Listed: 'listed, not funded', Open: 'open', Depleted: 'depleted', Rolled: 'rolled forward', Closed: 'closed' },
    claimStates: {
      Committed: 'committed',
      Revealable: 'revealable',
      Revealed: 'revealed, evaluation requested',
      Judged: 'judged',
      Disputed: 'disputed, dispute evaluation requested',
      Settled: 'settled',
      Expired: 'expired',
      RoundFailed: 'round ended without a verdict',
    },
    disputes: {
      None: 'not disputed',
      Pending: 'dispute pending',
      Held: 'disputed; the dispute panel gave the same outcome',
      Overturned: 'disputed; the dispute panel replaced the outcome',
      NoVerdict: 'disputed; the dispute round ended without a verdict and the first verdict stands',
    },
    kinds: { Repo: 'repository', Contract: 'deployed contract' },
    // which dispute-panel round a claim's dispute fields describe (errata E7, E9)
    disputeKinds: { None: 'none', Maker: 'the maker\'s dispute', Confirmation: 'the confirmation', Appeal: 'the hunter\'s appeal' },
    panelResults: {
      None: 'none',
      Pending: 'its round is open',
      Held: 'the dispute panel gave the same outcome',
      Overturned: 'the dispute panel replaced the outcome',
      NoVerdict: 'its round ended without a verdict',
    },
  },
  labels: {
    scanned: 'scanned',
    staked: 'staked',
    'under-staked': 'under-staked',
    invited: 'invited',
    lapsed: 'lapsed',
    noPrice: 'no stake label: no ETH/USD price to compare the top award with the declared value at risk',
    placeholders:
      'The badge floor and the under-staked share behind these labels are placeholder values until the program sets them at launch.',
  },
  // listings of a hash that do not count (node P9): shown apart, with no amount
  notCounted: {
    title: 'Not counted',
    intro:
      'These listings are on-chain but have no valid builder signature or no proof from the project. They add nothing to ' +
      'the stake, labels, feed or badge shown here, and this site offers no commit on them. Arbiters may still judge a ' +
      'listing whose archive a builder signed.',
    none: 'No listing of this hash counts.',
    listing: 'Listing {id}',
    maker: 'Maker',
    state: 'State',
    why: 'Why it does not count',
    findings: 'Valid findings under these listings: {count}, not counted on this record.',
    feedTitle: 'Not offered',
    feedIntro:
      'Listings that take claims on-chain but do not count: no valid builder signature, or no proof from the project. This site offers no commit on them.',
  },
  fork: {
    label: 'Fork',
    yes: 'The host\'s API says this repository is a fork of {parent}.',
    yesUnknownParent: 'The host\'s API says this repository is a fork.',
    no: 'The host\'s API says this repository is not a fork.',
    unknown: 'Unknown: the host\'s API gave no answer, or this host has none the site reads.',
  },
  // a listing's own page: whether the site offers a commit on it (node P9)
  offer: {
    title: 'Commits',
    yes: 'This listing counts: its builder\'s signature and the project\'s proof check, and the site offers it to hunters.',
    no: 'This site offers no commit on this listing: {reason}',
    unknown: 'This site could not read whether this listing counts: {reason}. It offers no commit until it can.',
  },
  feed: {
    title: 'Feed',
    intro:
      'Every listing that counts and takes claims now: a builder signed it, the project proved it, it is open, its ' +
      'listing fee is paid, and its escrow is at least its top award. Newest first.',
    loading: 'Reading the feed…',
    empty: 'No listing takes claims at this block.',
    entry: 'Listing {id}',
    artifact: 'Artifact',
    repoAt: '{repo} at {commit}',
    contractAt: '{address} on chain {chainId} ({repo} at {commit})',
    labels: 'Labels',
    awards: 'Award table',
    lowest: 'Lowest class counted',
    bond: 'Hunter bond',
    windows: 'Windows',
    windowsLine: 'fix {fix} days, dispute {dispute} hours, disclosure grace {grace} hours, reveal {reveal} days, disclose within {disclose} minutes of the commit',
    opened: 'Opened',
    fundedUntil: 'Listing fee paid until',
    daysOpen: 'Days open',
    claims: 'Claims so far',
    // tester bounty 400: claims on a listing reveal in commit order (decision D5), so a hunter sees the open ones first
    openClaims: 'Open claims',
    order: 'Commit order',
    orderNone: 'no claim is open: a claim committed now would be first',
    orderHead:
      'claim {head} is first: claims reveal in the order they were committed, so a claim committed now can be ' +
      'revealed only once every claim open before it is settled or expired',
    escrow: 'Escrow remaining',
    owed: 'Owed to hunters',
    valueAtRisk: 'Declared value at risk',
    image: 'Environment image',
    scope: 'Scope',
    scopeLine: 'in: {include}; out: {exclude}',
    documents: 'Where its requirements are written',
    documentsNone: 'no documents named',
    documentsUnread: 'not read from the listing archive yet',
    noArchive: 'not read from the listing archive ({reason})',
    record: 'Record of this hash',
    listing: 'Listing page',
    // node P35: the key in both forms, and the other listings of the repository
    disclosureKey: 'Disclosure key',
    sameRepository: 'Other listings of this repository',
  },
  // node P35 (claim test, items 3 and 4): wherever a listing's disclosure key or its repository's other listings show
  disclosure: {
    line: '{recipient} (on-chain, the bytes32 {bytes32})',
    note: DISCLOSURE_KEY_NOTE,
    // what each form's copy button copies, after copy.label
    copy: { recipient: 'the age recipient', bytes32: 'the bytes32 the contract stores' },
  },
  sameRepository: {
    title: 'Other listings of this repository',
    intro:
      'Each listing is a stake on one version, its repository at one commit (for a deployed contract, also its chain and ' +
      'address), with its own terms, scope, known issues and findings. The record is the version\'s: listings with the same ' +
      'artifact hash share it. A claim goes on one listing, and its proof must fail at that listing\'s commit.',
    none: 'none',
    line: 'Listing {id} at {commit}: {state}',
    notCounted: 'not offered by this site',
    lapsed: 'its listing fee has lapsed',
    unavailable: 'The other listings of this repository could not be read: {reason}',
  },
  record: {
    title: 'Record',
    intro:
      'The record of one artifact hash: every listing of it that counts, what was staked, what was judged, ' +
      'what was found, what fixed it and what was found later. Any other listing of the hash shows apart.',
    hash: 'Artifact hash (0x and 64 hex digits)',
    load: 'Show the record',
    loading: 'Reading the record…',
    badHash: 'An artifact hash is 0x and 64 hex digits.',
    notFound: 'No listing of artifact hash {hash} has opened, so it has no record.',
    artifact: 'Artifact',
    artifactHash: 'Artifact hash',
    kind: 'Kind',
    repo: 'Repository',
    commit: 'Commit',
    address: 'Contract address',
    chainId: 'Chain id',
    listingCount: 'Listings that count',
    active: 'Listings that count and are not closed',
    stakes: 'Stakes',
    listing: 'Listing {id}',
    maker: 'Maker',
    state: 'State',
    labels: 'Labels',
    awards: 'Award table',
    awardsLine: 'LOW {LOW}, MEDIUM {MEDIUM}, HIGH {HIGH}, CRITICAL {CRITICAL} ETH',
    lowest: 'Lowest class counted',
    bond: 'Hunter bond',
    escrow: 'Escrow remaining',
    owed: 'Owed to hunters',
    valueAtRisk: 'Declared value at risk',
    notDeclared: 'not declared',
    documents: 'Where its requirements are written',
    documentsNone: 'no documents named',
    documentsUnread: 'not read from the listing archive yet',
    documentsNote: STAKE_DOCUMENTS_NOTE,
    usd: '{usd} USD',
    shareLabel: 'Top award in USD',
    share: '{usd} USD at the block\'s ETH/USD price, {share}% of the declared value at risk',
    listedAt: 'Listed',
    openedAt: 'Opened',
    fundedUntil: 'Listing fee paid until',
    rolledAt: 'Rolled forward',
    closedAt: 'Closed',
    daysOpen: 'Days open, to its roll forward or close',
    eth: '{eth} ETH',
    none: 'none',
    listingPage: 'Listing page',
    history: 'History',
    claims: 'Claims committed',
    judged: 'Claims judged',
    pending: 'Claims pending',
    verdicts: 'Verdicts by outcome',
    verdictLine: '{outcome}: {count}',
    // claims that failed integrity (owner decision Q35, condition 3): what the checks found, never who caused it
    integrity: 'Claims that failed integrity',
    integrityChecks: 'Checks that failed, with how many of those claims name each',
    integrityCheckLine: '{check}: {count}',
    integrityLate: 'Late claims that failed integrity',
    integrityLateChecks: 'Checks those late claims name',
    integrityOther: 'Other duplicates',
    integrityUnread: 'Duplicates with a justification not read, or read differently',
    integrityNote: INTEGRITY_NOTE,
    integrityUnreadNote:
      'A justification that could not be read, or arbiters whose justifications say different things, count as a plain duplicate, ' +
      'never as a failed check. A read that failed is tried again.',
    released: 'Claims the maker released early',
    undisclosed: 'Commits expired undisclosed',
    unrevealed: 'Commits expired unrevealed',
    noVerdict: 'Claims expired after rounds without a verdict',
    disputes: 'Disputes filed',
    disputeResults: 'Dispute outcomes',
    disputeLine: 'same outcome {held}, outcome replaced {overturned}, no verdict {noVerdict}',
    // the settlement safeguards (errata E7-E9), counted apart from the maker's disputes, each by its final result
    appeals: 'Appeals of an INVALID by its hunter',
    appealResults: 'Appeal outcomes',
    appealLine: 'INVALID again {held}, outcome replaced {overturned}, no verdict {noVerdict}',
    confirmations: 'Confirmation rounds, paid from the escrow',
    confirmationResults: 'Confirmation outcomes',
    confirmationLine: 'same outcome {held}, outcome replaced {overturned}, paid from the deadline with no verdict {noVerdict}',
    narrowInvalid: 'INVALID verdicts in the narrow band, bond returned (counted within INVALID)',
    lateAppeals: 'Late claims\' appeals',
    lateNarrowInvalid: 'Late claims\' INVALID verdicts in the narrow band, bond returned',
    narrowFloor: 'Narrow INVALID floor',
    narrowFloorLine: '{floor} of 1,000,000 ({points} points) of valid mass',
    narrowFloorEmpty: 'the empty band: every INVALID forfeits its bond',
    confirmSize: 'Confirmation size',
    confirmSizeLine: 'awards above {size} ETH wait for the dispute panel',
    confirmSizeAll: '0: every counted award waits for the dispute panel',
    findingRound: '{kind}: {result}',
    daysSince: 'Days since the last valid finding',
    noValidFinding: 'no valid finding recorded',
    findings: 'Valid findings',
    noFindings: 'No valid finding is recorded.',
    findingClaim: 'Claim',
    findingClass: 'Class',
    findingListing: 'Listing',
    findingHunter: 'Hunter',
    findingPaid: 'Paid',
    findingOwed: 'Owed',
    findingRevealed: 'Public from',
    findingSettled: 'Settled',
    findingDispute: 'Dispute',
    findingArchive: 'Archive',
    lineage: 'Lineage',
    predecessor: 'Predecessor, the version this one fixed',
    successor: 'Successor, the version that fixed this one',
    lineageLine: 'listing {id}, artifact hash {hash}',
    later: 'Found later',
    laterIntro: 'Claims made against this hash after a stake on it rolled forward or closed. They carry no award.',
    lateClaims: 'Late claims made',
    lateVerdicts: 'Late claims judged, by outcome',
    lateExpired: 'Late claims expired',
    noLaterFindings: 'No later finding is recorded.',
    flags: 'Bad-disclosure flags',
    flagsIntro:
      'A flag is the maker\'s statement that a disclosed copy did not decrypt or did not match its commitment. ' +
      'It is a claim, not a verdict: a flagged claim judged other than INVALID passed the arbiters\' disclosure check.',
    noFlags: 'No bad-disclosure flag is recorded.',
    flagClaim: 'Claim',
    flagListing: 'Listing',
    flagDisclosed: 'Disclosed',
    flagState: 'Claim state',
    flagJudged: 'Verdict',
    flagLate: 'late claim',
    notJudged: 'not judged',
    judgedLine: '{outcome}, {time}',
  },
  badge: {
    title: 'Badge',
    intro: 'The badge shows the live state of the stake on this hash. It changes with the record and ends when the stake ends.',
    alt: 'verdikta stake',
    markdown: 'Markdown',
    html: 'HTML',
  },
  // design §4.1, §4.2 and §15: what a record does and does not mean
  diligence: {
    title: 'What a record says, and what it does not',
    facts:
      'A stake record is live on-chain state bound to an artifact hash. It states facts: what was staked, for ' +
      'how long, what was judged, what was found, what was fixed and what was found later. It is an attestation ' +
      'of stake and judgement, never a security claim.',
    badge:
      'The badge is the live state. Funds stay escrowed and the stake stays open on the hash while the badge is ' +
      'shown; closing the stake ends the badge and leaves the history. A quiet period attests only that nobody ' +
      'who looked valued a finding below the award.',
    amount:
      'The reader interprets the amount. The record shows the stake, the bond and, when the maker declared one, ' +
      'the stake as a share of the value at risk. Tiers are not named; the site labels each listing:',
    labelList: [
      'scanned: the top award is below the program floor, and the badge says nothing beyond "scanned";',
      'staked: the top award is at or above the floor;',
      'under-staked: the maker declared a value at risk, and the top award is below a program-set share of it;',
      'invited: only allow-listed hunters may claim, the weaker attestation it is.',
    ],
    readingsIntro: 'An unclaimed stake means one of five things:',
    readings: [
      'no finding exists at the staked class;',
      'nobody competent looked;',
      'someone found one worth more than the award and is holding it;',
      'the jury wrongly rejected a real finding;',
      'or the rules made a real finding unclaimable.',
    ],
    readingsAfter:
      'Which reading applies depends on the award against two quantities: the cost of looking and the value of holding.',
    looking:
      'The cost of looking is near zero for small artifacts. Any listing the feed announces will be scanned, so ' +
      'small stakes do get attention, of the kind the maker could buy for a dollar of inference. The record is ' +
      'therefore defined by severity: the maker names the lowest class that counts, and the badge reads "no ' +
      'finding at or above that class while staked".',
    holding:
      'The value of holding is the hold problem. A $1,000 stake on a contract securing $10M tells every hunter ' +
      'that any real finding is worth more unheld. A maker may declare the value at risk; the record then shows ' +
      'the ratio and labels the listing under-staked when the stake is below the program\'s share of it.',
    tableTitle: 'What an unclaimed period attests, by top award',
    tableHead: { award: 'Top award', who: 'Who looks', attests: 'What an unclaimed period attests', label: 'Label' },
    table: [
      { award: 'about $10 to $50', who: 'Scanners, if a feed exists', attests: 'Nothing a scanner reaches; the maker could run that', label: 'scanned' },
      { award: 'about $100 to $500', who: 'Scanners plus agent passes over small artifacts (skills, MCP servers, small contracts)', attests: 'No medium-or-worse issue an agent pass finds at that budget', label: 'staked' },
      { award: 'about $1k to $10k', who: 'Serious agent audits, some humans', attests: 'No High found while staked', label: 'staked; the dispute window applies' },
      { award: '$50k or more', who: 'Human specialists', attests: 'The only level credible for value-bearing code', label: 'staked' },
    ],
    feed:
      'The feed lists every listing that takes claims: hash, image, scope, award table, bond, windows, days open, ' +
      'claims so far and escrow remaining. The baseline scan, funded by the listing fee, is the floor of attention ' +
      'every record gets.',
    hunters:
      'Autonomous hunters are welcome. A claim is judged in minutes once its fix window ends, awards are paid ' +
      'on-chain, and a bond, not a ban, prices invalid claims.',
  },
  claim: {
    title: 'Claim',
    intro:
      'One hunter\'s claim against a listing, as the chain holds it now, and what the listing\'s maker can do with it.',
    claimId: 'Claim id',
    load: 'Show the claim',
    loading: 'Reading the claim…',
    notFound: 'There is no claim {id}.',
    readFailed: 'The claim could not be read: {reason}',
    retry: 'Read again',
    summary: 'Claim {id} on listing {listingId}',
    state: 'State',
    late: 'Late claim',
    hunter: 'Hunter',
    committedAt: 'Committed',
    disclosedAt: 'Disclosed',
    fixWindowEnd: 'Fix window ends',
    released: 'Released by the maker',
    revealedAt: 'Revealed',
    judgedAt: 'Judged',
    outcome: 'Outcome',
    dispute: 'Dispute',
    settledAt: 'Settled',
    paid: 'Paid',
    yes: 'yes',
    no: 'no',
    notYet: 'not yet',
    listingPage: 'Listing {id}',
    checkPage: 'Check the disclosure',
    notMaker: 'Only the listing\'s maker ({maker}) can do this; your wallet is {account}.',
    failed: 'The transaction failed: {reason}',
    changed: 'Nothing was sent: the claim changed on-chain since this page read it. It has been read again.',
    // commit order (decision D5; ClaimLogic.revealDeadline): a claim behind another on its listing waits, whatever
    // its own fix window says, and the lens gives it no reveal deadline until it is first (tester bounty 400)
    queue: 'Commit order',
    queueFirst: 'first on its listing: no earlier claim is open',
    queueWaits:
      'waits for claim {head}: claims on a listing reveal in the order they were committed, so this one can be ' +
      'revealed only once claim {head}, and any claim between the two, is settled or expired',
    queueLink: 'Claim {id}, which comes first',
    revealBefore: 'Reveal before',
    revealFirm: '{time}',
    revealLatest: '{time} at the latest: a release or a roll-forward ends the fix window sooner, and the reveal window runs from then',
    // a listing that is Rolled or Closed cannot roll forward: only a release ends the window early there
    revealLatestRelease: '{time} at the latest: a release ends the fix window sooner, and the reveal window runs from then',
    revealOver:
      '{time}, which has passed: the hunter can no longer reveal it, and anyone may expire it. That sends its bond to ' +
      'the maker and makes the next claim on the listing first',
    revealUnset: 'not set: the reveal window starts once this claim is first in commit order and its fix window is over',
    // erratum E5: an undisclosed claim past its disclose window is expired by anyone, whatever its place
    queueUndisclosedOver:
      'never disclosed, and its time to disclose is over: it can no longer be revealed, and anyone may expire it, ' +
      'whatever its place in commit order. That sends its bond to the maker and takes it out of the order',
    // erratum E6: a claim whose round ended with no verdict keeps its place until it is expired or a round settles
    retrigger: 'Round with no verdict',
    retriggerUntil: 'the hunter may send the round again until {time}; the claim keeps its place in commit order meanwhile',
    retriggerOver: 'the time to send the round again ended at {time}: anyone may expire the claim, which takes it out of commit order',
    // the settlement safeguards (design §13.2, errata E7-E9), each from the contract's own reads
    roundKind: 'Dispute-panel round',
    roundKindLine: '{kind}: {result}',
    appeal: 'Appeal window',
    appealUntil: 'The hunter may appeal this INVALID to the dispute panel until {time}, paying the live dispute fee.',
    appealOver: 'The appeal window ended at {time}.',
    appealRetrigger: 'The appeal\'s round ended without a verdict: the hunter may re-trigger it once, for a fresh fee, until {time}.',
    waiver:
      'Until {time} only the hunter may settle this INVALID, and a hunter who settles it before then waives the appeal. ' +
      'From then on anyone may settle it, the site\'s keeper included, and nothing is waived.',
    confirmation: 'Confirmation',
    confirmationStates: {
      awaiting: 'the award is above the listing\'s confirmation size: the dispute panel confirms it before it pays. A round may start from {opensAt}, the end of the dispute window; if none returns a verdict, the first verdict pays from {deadline}.',
      open: 'awaits the dispute panel\'s confirmation: anyone may start a round until {deadline}, and the site\'s keeper does. If none returns a verdict, the first verdict pays from then.',
      pending: 'a round of the dispute panel is open; the confirmation deadline is {deadline}.',
      closed: 'the confirmation deadline, {deadline}, has passed: with no round open, the first verdict pays.',
      held: 'the dispute panel confirmed the outcome.',
      overturned: 'the dispute panel replaced the outcome: the panel\'s outcome is the one settle applies.',
      noVerdict: 'no round of the dispute panel returned a verdict before the deadline, so the first verdict paid.',
    },
    narrow: 'Narrow INVALID',
    narrowYes: 'yes: its valid mass is at least the listing\'s floor, so the bond comes back if this verdict settles',
    narrowNo: 'no: the bond goes to the maker if this verdict settles',
    bond: 'Bond',
    bonds: {
      returned: 'returned to the hunter',
      returnedNarrow: 'returned to the hunter: a narrow INVALID, with no award',
      forfeited: 'forfeited to the maker',
    },
  },
  release: {
    title: 'Release',
    intro:
      'Releasing waives the rest of the fix window for this claim: the hunter may reveal it now and the arbiters ' +
      'judge it.',
    // a release ends the fix window, not the wait behind an earlier claim (decision D5)
    introWaits:
      'Releasing waives the rest of the fix window for this claim. The hunter still cannot reveal it then: claims on ' +
      'a listing reveal in the order they were committed, and claim {head} comes first. This one can be revealed once ' +
      'claim {head}, and any claim between the two, is settled or expired.',
    // said after either intro, of a claim that is not late: ClaimLogic.release counts no late claim
    counted: 'The record counts the claim as released.',
    until: 'The fix window ends at {time}.',
    button: 'Release the claim',
    sending: 'Sending release()…',
    done: 'Released (transaction {tx}). The claim is revealable now.',
    doneWaits:
      'Released (transaction {tx}). The fix window is over, and the claim still waits for claim {head}, which is ' +
      'first in commit order: the hunter can reveal it once claim {head}, and any claim between the two, is settled ' +
      'or expired.',
    // while the page has no read of the claim to say which, or the claim has moved on since
    doneBare: 'Released (transaction {tx}).',
  },
  roll: {
    title: 'Roll forward',
    intro:
      'Roll the stake forward to a fixed version: your own listing of the same repository at another commit, ' +
      'already open. This listing then takes no new claims, the fix window of every claim disclosed on it ends at once ' +
      '(each can then be revealed in commit order), and the record links the two versions.',
    // Node P38: what a maker does before publishing a fix. A version is validated from its public repository, so a
    // fixed commit is public before it can be listed, and commit() is taken on an Open listing until close() or
    // rollForward(). close() is refused while a claim is pending or an award is owed; rollForward() needs a successor
    // that is already Open, so a close can come before the push and a roll cannot. The first line is the rule a maker
    // can keep (a close first, where the contract allows one); the third says what a roll costs where it does not.
    // Each is one line of the page's text (test/rollGuidance.test.js).
    fix: {
      keep:
        'Keep a fix private until this listing is closed, when it can be closed: the stake has then left this commit ' +
        'before anyone reads the fix. A roll forward cannot come before the push: the site validates a version from ' +
        'its public repository, so a fixed commit is public before it can be listed. A hunter who reads the fix can ' +
        'claim the bug here for as long as this listing takes claims.',
      noClaim:
        'If no claim on this listing is pending (each is settled or expired), close it first. Once it is closed, push ' +
        'the fix and list the fixed commit. A close is refused while an award is owed: a top-up pays what is owed first.',
      claimPending:
        'If a claim is pending, this listing cannot be closed until every pending claim is settled or expired. To roll ' +
        'forward before then, the fix has to be public first: push it, then validate, list and fund the fixed commit, ' +
        'and roll forward, all in one sitting. From the push until this listing has rolled forward, it takes claims ' +
        'as before.',
    },
    loading: 'Looking for your open listings of this repository…',
    pick: 'Successor listing',
    option: 'Listing {id}: {commit}, escrow {escrow} ETH, open since {opened}',
    none:
      'You have no open listing of this repository to roll to. A roll needs the fixed version listed and funded ' +
      'first: read the order above before you push it.',
    noIdentity: 'This listing\'s repository is not in the site\'s record yet, so its successors cannot be found here.',
    // the record's read failed: the panel still shows, with the lines above, and only the picker is missing
    recordFailed: 'This listing\'s record could not be read, so its successors cannot be found here: {reason}',
    feedFailed: 'The open listings could not be read: {reason}',
    button: 'Roll forward to listing {id}',
    sending: 'Sending rollForward()…',
    done: 'Rolled forward to listing {id} (transaction {tx}).',
    changed: 'Nothing was sent: listing {id} is no longer an open listing of yours without a predecessor, or this listing can no longer roll forward. Reload the page.',
  },
  // A listing's later life, on its own page (design §13.2): the contract's renew(), close() and withdraw().
  topUp: {
    title: 'Top up the escrow',
    intro:
      'A top-up adds to this listing\'s escrow, with no fee. What the listing owes hunters is paid first, claim by ' +
      'claim in the order they were committed, and the rest goes to the escrow. An amount paid to a hunter this way ' +
      'is held by the contract for that hunter to withdraw.',
    escrow: 'Escrow now: {eth} ETH. Top award: {top} ETH.',
    owed: 'Owed to hunters: {eth} ETH. A top-up pays this first.',
    depleted:
      'This listing is depleted: its escrow is below its top award, so it takes no new claims. It reopens once ' +
      'nothing is owed and the escrow is back at the top award, which takes {eth} ETH or more.',
    rolled:
      'This listing rolled forward: it takes no new claims, and a top-up does not reopen it. Its escrow pays the ' +
      'claims still settling against it.',
    amount: 'Amount (ETH)',
    positive: 'Enter an amount above 0.',
    effect: 'Of this, {owed} ETH goes to hunters who are owed it and {rest} ETH to the escrow, which will then hold {after} ETH.',
    effectPlain: 'The escrow will then hold {after} ETH.',
    reopens: 'The listing reopens.',
    button: 'Top up, paying {eth} ETH',
    buttonNoAmount: 'Top up',
    sending: 'Sending fund()…',
    done: 'Topped up (transaction {tx}). The escrow now holds {eth} ETH.',
    doneOwed: 'Topped up (transaction {tx}). {owed} ETH went to hunters who were owed it, and the escrow now holds {eth} ETH.',
    reopened: 'The listing is open again.',
    changed: 'Nothing was sent: listing {id} can no longer be topped up (it is {state}). It has been read again.',
  },
  renew: {
    title: 'Renew',
    intro:
      'The listing fee pays for 30 days. Renewing pays it again and adds 30 days to the paid period. Once the period ' +
      'has lapsed the listing takes no new claims, and a renewal then runs 30 days from the moment it is sent: the gap ' +
      'is not paid for. The escrow is not touched.',
    until: 'The listing fee is paid until {time}.',
    lapsed: 'The paid period ended at {time}: this listing takes no new claims until it is renewed.',
    fee: 'Listing fee for 30 more days: {fee} ETH',
    feeLoading: 'Reading the listing fee…',
    button: 'Renew for 30 days, paying {fee} ETH',
    sending: 'Sending renew()…',
    done: 'Renewed (transaction {tx}). The listing fee is paid until {until}.',
    feeChanged: 'Nothing was sent: the listing fee is now {fee} ETH. The figure above is updated; renew again to pay it.',
    changed: 'Nothing was sent: listing {id} can no longer be renewed (it is {state}). It has been read again.',
  },
  close: {
    title: 'Close',
    intro:
      'Closing ends this stake: the listing takes no new claims, and the badge no longer states it. The escrow that ' +
      'is left comes back to your wallet. The record keeps its history, and a claim made on this version afterwards ' +
      'is a late claim, which carries no award. A closed listing cannot be reopened: to stake on this version again, ' +
      'list it again.',
    escrow: 'Escrow that comes back: {eth} ETH.',
    pending: 'This listing has claims that are neither settled nor expired ({count}). It can be closed once each of them is.',
    owed: 'This listing still owes hunters {eth} ETH. It can be closed once that is paid.',
    ask: 'Close listing {id}',
    confirm: 'Close listing {id} and take back {eth} ETH',
    keep: 'Keep it open',
    sending: 'Sending close()…',
    done: 'Listing {id} is closed (transaction {tx}). {eth} ETH of escrow went back to {account}.',
    doneDeferred:
      'Listing {id} is closed (transaction {tx}). The contract could not send the {eth} ETH of escrow to {account}, ' +
      'so it holds the amount for that wallet: withdraw it below.',
    changed: 'Nothing was sent: listing {id} changed on-chain since this page read it. It has been read again.',
  },
  withdraw: {
    title: 'Withdraw',
    intro:
      'The contract holds some amounts until their wallet collects them: listing fees for the fee recipient, an award ' +
      'that was owed and has since been paid from a top-up, a refund that arrives after its listing closed, and any ' +
      'payment the contract could not send directly. Withdrawing sends this wallet all that is held for it.',
    held: 'The contract holds {eth} ETH for {account}.',
    button: 'Withdraw {eth} ETH',
    sending: 'Sending withdraw()…',
    done: 'Withdrawn (transaction {tx}): {eth} ETH to {account}.',
    changed: 'Nothing was sent: the contract holds nothing for {account} now.',
  },
  dispute: {
    title: 'Dispute',
    intro:
      'You may dispute a valid verdict once, until {deadline}. A stronger panel re-judges the claim, and its ' +
      'outcome is final. A dispute that turns the outcome INVALID forfeits the hunter\'s bond to you, unless the ' +
      'panel\'s verdict is a narrow INVALID, whose bond goes back to the hunter; one that holds is recorded as a failed dispute. ' +
      'Above the listing\'s confirmation size, your dispute is the confirmation.',
    prepay: 'Escalation prepay: {fee} ETH, the dispute panel\'s maxTotalFee read from the chain. What the oracles do not spend comes back to you.',
    prepayLoading: 'Reading the escalation prepay…',
    statement: 'Your statement (at most {max} bytes of UTF-8 text)',
    statementHint:
      'It is pinned to IPFS and its CID goes on-chain with the dispute; the dispute panel reads it as your argument. ' +
      'Your wallet signs a sign-in message first, which costs nothing and moves no funds.',
    bytes: '{bytes} of {max} bytes',
    empty: 'Write the statement before you dispute.',
    tooLong: 'The statement is {bytes} bytes; the most is {max}.',
    malformed: 'The statement holds characters that are not valid UTF-8 text.',
    button: 'Pin the statement and dispute, paying {fee} ETH',
    checking: 'Reading the claim and the escalation prepay again…',
    signing: 'Waiting for your wallet to sign in…',
    pinning: 'Pinning the statement…',
    sending: 'Sending dispute()…',
    pinned: 'Statement pinned: {cid}',
    cidMismatch: 'Nothing was sent: the server answered CID {cid}, which is not the CID of your statement.',
    feeRose: 'Nothing was sent: the escalation prepay is now {fee} ETH. The figure above is updated; dispute again to pay it.',
    closed: 'Nothing was sent: this claim can no longer be disputed.',
    pinFailed: 'The statement could not be pinned: {reason}',
    done: 'Disputed (transaction {tx}). The dispute panel\'s evaluation is requested.',
  },
  pending: {
    claim: 'The claim was revealed at {time} and its evaluation requested. Waiting for the arbiters\' verdict: this page reads the chain every {seconds} seconds for up to {minutes} minutes.',
    dispute: 'The claim was disputed at {time} and the dispute panel\'s evaluation requested. Waiting for its verdict: this page reads the chain every {seconds} seconds for up to {minutes} minutes.',
    disputeSent: 'The dispute was sent. Waiting for the dispute panel\'s verdict: this page reads the chain every {seconds} seconds for up to {minutes} minutes.',
    appeal: 'The hunter appealed at {time} and the dispute panel\'s evaluation is requested. Waiting for its verdict: this page reads the chain every {seconds} seconds for up to {minutes} minutes.',
    confirmation: 'The confirmation round started at {time}, paid from the escrow, and the dispute panel\'s evaluation is requested. Waiting for its verdict: this page reads the chain every {seconds} seconds for up to {minutes} minutes.',
    typical: 'A verdict usually takes 3 to 6 minutes, and the site\'s keeper records it on-chain.',
    timedOut:
      'No verdict was recorded in {minutes} minutes of checking. The arbiters may still be working, or the round may ' +
      'end without a verdict; either is recorded on-chain when it happens. This page has stopped checking.',
    recheck: 'Check again',
  },
  // the baseline scan's findings (design §8.3; the server's P4b2 routes): the maker's alone
  scan: {
    title: 'Baseline scan',
    intro:
      'Before the listing opens, the site scans the staked version: Semgrep with Verdikta\'s pinned rules and a ' +
      'secret scan over the in-scope paths, and, where the site runs it, one inexpensive agent pass. The findings ' +
      'are for you only. The scan is not a judgement and pays nobody: nothing from it enters the listing archive, ' +
      'the record, the jury\'s inputs or your known issues unless you put it there.',
    status: 'Baseline scan: {status}',
    statuses: {
      pending: 'waiting for the build',
      running: 'running',
      done: 'finished',
      error: 'stopped with an error',
      not_run: 'not run: the listing was not issued',
    },
    read: 'Sign in with your wallet to read the scan',
    signing: 'Waiting for your wallet to sign in…',
    reading: 'Reading the scan…',
    notMaker: 'The scan is for the wallet the listing request named ({maker}); your wallet is {account}.',
    failed: 'The scan could not be read: {reason}',
    docStatus: 'Scan status: {status}',
    stopped: 'The scan stopped: {code}: {detail}',
    tools: 'Tools',
    tool: '{name}: {status}',
    files: 'Files in scope: {inScope}; in scope but not read: {skipped}',
    findings: 'Findings: {count}',
    none: 'The scan lists no finding.',
    toolFinding: '{tool} {rule} ({severity}), {path} line {line}: {message}',
    agentFinding: 'agent pass, {class}: {title} ({paths}). How it would be demonstrated: {demonstration}',
  },
  claims: {
    title: 'Claims on this listing',
    none: 'No claim has been committed on this listing.',
    line: 'Claim {id}',
    unavailable: 'The claims could not be listed: {reason}. A claim can still be opened by its id.',
    record: 'Record of this version',
    // commit order (decision D5), from the listing as the chain has it: pendingClaims and headClaim
    open: 'Open now, neither settled nor expired: {count}.',
    // a Rolled listing can hold claims from before the roll and late claims after it, in one queue
    openLate: 'Open now, neither settled nor expired: {count}, of which late claims: {late}.',
    order: 'Claims reveal in the order they were committed, and claim {head} is first: each later claim can be revealed only once every claim committed before it is settled or expired.',
    allResolved: 'None is open now: each is settled or expired.',
  },
};

/** The template with each {name} replaced by vars[name]. */
export function fill(template, vars = {}) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
}
