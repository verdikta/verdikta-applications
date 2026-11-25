/**
 * Class policy for bounty creation and validation.
 *
 * Verdikta classes are permissionless: anyone can run arbiters registered for a
 * new class ID and advertise what that class means (models, tools, special
 * capabilities). The class registry in @verdikta/common is optional metadata,
 * not a gate. So:
 *
 *  - a class IN the registry: its jury models are checked against the
 *    registry's model list. An unservable model strands the whole funded bounty
 *    (bounty 164: every submission failed and the escrow sat until expiry).
 *  - a class NOT in the registry: allowed. Its jury can't be checked here, so
 *    callers get a warning instead of a refusal.
 *  - any class: refused only on a chain fact. When no arbiter is eligible to serve
 *    the class at the bounty's fee limit, ReputationKeeper.selectArbiters reverts
 *    (NoEligibleArbiters) at every draw, so the bounty could never be evaluated.
 *    Fewer than K (the bounty's jury's draw size) is a warning: the keeper then
 *    repeats arbiters to fill the jury's K slots.
 */

const { ethers } = require('ethers');
const logger = require('./logger');
const { isVerdiktaServiceAvailable, getVerdiktaService } = require('./verdiktaService');

function loadClassMap() {
  try {
    const classMap = require('@verdikta/common')?.classMap;
    return classMap && typeof classMap.getClass === 'function' ? classMap : null;
  } catch (e) {
    logger.warn('[classPolicy] classMap unavailable', { msg: e.message });
    return null;
  }
}

function classMapVersion(classMap) {
  try {
    return typeof classMap?.getMapVersion === 'function' ? classMap.getMapVersion() : null;
  } catch {
    return null;
  }
}

function lookupClass(classId, classMap = loadClassMap()) {
  if (!classMap) return { listed: null, classInfo: null };
  try {
    const classInfo = classMap.getClass(Number(classId));
    return { listed: !!classInfo, classInfo: classInfo || null };
  } catch (e) {
    logger.warn('[classPolicy] classMap lookup failed', { classId, msg: e.message });
    return { listed: null, classInfo: null };
  }
}

function unlistedClassWarning(classId, version) {
  return `Class ${classId} is not in the Verdikta class registry` +
    (version ? ` (@verdikta/common class map ${version})` : '') +
    '. That is allowed: anyone can run arbiters for a new class. But the jury models (or tools) ' +
    'cannot be checked here, so use exactly the provider/model identifiers the class\'s arbiter ' +
    'operators advertise. If their nodes don\'t serve an identifier, every evaluation fails, and ' +
    'the bounty cannot be edited or canceled once it is on-chain.';
}

const normalizeProvider = (provider) => String(provider || '').trim().toLowerCase();

/**
 * Check a jury against the class registry.
 *
 * Returns { listed, classInfo, juryModelsVerified, errors, warnings, invalidNodes, allowedModels }.
 * `listed` is null when the registry could not be read (fail-open: no errors).
 */
function checkJuryAgainstClass(juryNodes, classId, classMap = loadClassMap()) {
  const result = {
    listed: null,
    classInfo: null,
    juryModelsVerified: false,
    errors: [],
    warnings: [],
    invalidNodes: [],
    allowedModels: null
  };
  const { listed, classInfo } = lookupClass(classId, classMap);
  result.listed = listed;
  result.classInfo = classInfo;

  if (listed === null) {
    result.warnings.push(`Could not read the class registry to check the jury against class ${classId}.`);
    return result;
  }
  if (!listed) {
    result.warnings.push(unlistedClassWarning(classId, classMapVersion(classMap)));
    return result;
  }
  if (classInfo.status !== 'ACTIVE') {
    result.errors.push(`Class ${classId} is not ACTIVE in the class registry (status=${classInfo.status})`);
    return result;
  }

  const available = new Set((classInfo.models || []).map(m => `${normalizeProvider(m.provider)}/${m.model}`));
  for (const node of juryNodes || []) {
    if (!available.has(`${normalizeProvider(node.provider)}/${node.model}`)) {
      result.invalidNodes.push({ provider: node.provider, model: node.model });
    }
  }
  for (const n of result.invalidNodes) {
    result.errors.push(`Jury model ${n.provider}/${n.model} is not available in class ${classId}`);
  }
  result.allowedModels = Array.from(available).sort();
  result.juryModelsVerified = result.invalidNodes.length === 0;
  return result;
}

/**
 * Predicate for validateJuryNodes' isRegistryModel option: true when (provider, model)
 * is exactly on the registry list of a listed ACTIVE class. Null for any other class.
 */
function registryModelMatcher(classId, classMap = loadClassMap()) {
  const { listed, classInfo } = lookupClass(classId, classMap);
  if (!listed || classInfo.status !== 'ACTIVE') return null;
  const ids = new Set((classInfo.models || []).map(m => `${normalizeProvider(m.provider)}/${m.model}`));
  return (provider, model) => ids.has(`${normalizeProvider(provider)}/${model}`);
}

const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Live arbiter coverage for a class at a given fee limit and jury, from the on-chain
 * ReputationKeeper registry (the keeper's selection rule: registered, not paused, banned,
 * exiting or under-staked, not blocked or frozen, fee <= the bounty's ceiling, registered for
 * the class).
 *
 * A v2 draw fills K slots for the bounty's jury (K is the bounty's own, or its class preset's).
 * With fewer than K distinct eligible arbiters the keeper repeats arbiters (slot k holds pick
 * k mod m); only with none does every draw fail (EvaluationFailed in the draw phase, the prepay
 * refunded), so only then is the class unservable.
 *
 * Returns { coverage, refusal, warnings }:
 *  - coverage: summary for API responses (coverage.checked=false when the chain
 *    couldn't be read; callers then proceed, as with any infra failure)
 *  - refusal: set only when no arbiter is eligible (no jury can be drawn at all)
 *  - warnings: fewer than K eligible (or a beacon bounty's quorum short), a single operator, priced-out arbiters, and arbiters owned by the creator's own address
 */
async function checkClassCoverage(classId, oracleSettings, { creator, jury = null } = {}) {
  const cls = Number(classId);
  if (!isVerdiktaServiceAvailable()) {
    return {
      coverage: { checked: false, classId: cls, reason: 'Verdikta service not configured on this server' },
      refusal: null,
      warnings: []
    };
  }

  let r;
  try {
    r = await getVerdiktaService().getClassOracleEligibility(cls, oracleSettings, { jury });
  } catch (e) {
    logger.warn('[classPolicy] coverage read failed — proceeding unchecked', { classId: cls, msg: e.message });
    return {
      coverage: { checked: false, classId: cls, reason: e.message },
      refusal: null,
      warnings: [`Could not check arbiter coverage for class ${cls} right now (${e.message}).`]
    };
  }

  const creatorLc = creator ? String(creator).toLowerCase() : null;
  const creatorOperatedCount = creatorLc
    ? (r.eligibleArbiters || []).filter(a => a.owner && String(a.owner).toLowerCase() === creatorLc).length
    : 0;
  const maxFeeEth = r.oracleSettings?.maxOracleFeeEth ?? ethers.formatEther(BigInt(String(oracleSettings?.maxOracleFee ?? 0)));
  const K = Number(r.drawSize ?? r.oraclesToPoll) || 0;

  const coverage = {
    checked: true,
    classId: cls,
    totalInClass: r.totalInClass,
    activeInClass: r.activeInClass,
    eligibleCount: r.eligibleCount,
    pricedOutCount: r.pricedOutCount,
    distinctOwnersEligible: r.distinctOwnersEligible,
    // K: the slots a draw fills for this jury (the bounty's or its preset's)
    oraclesToPoll: r.oraclesToPoll,
    juryDrawSize: K,
    ...(r.jury ? { jury: r.jury } : {}),
    ...(r.beaconQuorum != null ? { beaconQuorum: r.beaconQuorum, beaconsServable: r.beaconsServable } : {}),
    ...(r.scansAll != null ? { scansAll: r.scansAll } : {}),
    maxOracleFeeEth: maxFeeEth,
    creatorOperatedCount,
    checkedAt: r.checkedAt
  };

  // Refused only when nothing can be drawn at all (no eligible arbiter). Fewer than K, or fewer
  // than a beacon bounty's quorum, is a warning: the count moves as arbiters freeze, answer, join
  // and leave, so a creator may post first and wait for coverage (owner decision, 2026-11-24).
  let refusal = null;
  const warnings = [];
  if (r.eligibleCount === 0) {
    if (r.totalInClass === 0) {
      refusal = `No arbiters are registered for class ${cls}, so no jury could ever be drawn. Arbiter operators ` +
        'register for a class first; create the bounty once its arbiters are live.';
    } else if (r.activeInClass > 0 && r.pricedOutCount === r.activeInClass) {
      refusal = `All ${r.activeInClass} selectable arbiter(s) in class ${cls} charge more than this bounty's ` +
        `max oracle fee (${maxFeeEth} ETH), so none could be drawn. Raise oracleMaxOracleFee or pick another class.`;
    } else {
      refusal = `None of the ${r.totalInClass} arbiter(s) registered for class ${cls} is currently selectable ` +
        `(not paused, banned, blocked, frozen, exiting or under-staked) at this bounty's max oracle fee (${maxFeeEth} ETH), ` +
        'so no jury could be drawn. Try again once they are back, or pick another class.';
    }
  } else if (r.eligibleCount < K) {
    warnings.push(`Only ${r.eligibleCount} eligible arbiter(s) in class ${cls}, and this jury draws ${K}: ` +
      `until more are eligible at the time of a request, the draw repeats arbiters to fill its ${K} slots, so the ` +
      `jury holds only ${r.eligibleCount} independent arbiter(s).`);
  }
  if (!refusal && r.beaconsServable === false) {
    warnings.push(`This bounty uses beacons: the beacon stage needs ${r.beaconQuorum} selectable arbiter(s) in class ${cls} ` +
      `(beacons have no fee cap), but only ${r.activeInClass} are, so until more are, its draw fails at the beacon stage (refunded).`);
  }

  if (!refusal) {
    if (r.distinctOwnersEligible === 1) {
      const owner = r.dominantOwner ? ` (${shortAddr(r.dominantOwner)})` : '';
      warnings.push(`All ${r.eligibleCount} eligible arbiter(s) in class ${cls} belong to one operator${owner}: ` +
        'no redundancy, and that operator controls every arbiter that can evaluate this bounty.');
    }
    if (r.pricedOutCount > 0) {
      warnings.push(`${r.pricedOutCount} selectable arbiter(s) in class ${cls} charge more than this bounty's max ` +
        `oracle fee (${maxFeeEth} ETH) and will not be drawn.`);
    }
    if (creatorOperatedCount > 0) {
      warnings.push(`The creator's address operates ${creatorOperatedCount} of the ${r.eligibleCount} eligible ` +
        `arbiter(s) in class ${cls}. Hunters will see this on the bounty page.`);
    }
    if (r.scansAll === false && r.beaconQuorum != null) {
      warnings.push(`Class ${cls} is longer than one selection walk covers: how many eligible arbiters a draw finds ` +
        'depends on the seed, and after a beacon stage a draw that finds none sends the unspent prepay to the arbiter pool.');
    }
  }

  return { coverage, refusal, warnings };
}

module.exports = {
  loadClassMap,
  classMapVersion,
  lookupClass,
  registryModelMatcher,
  checkJuryAgainstClass,
  checkClassCoverage,
  unlistedClassWarning
};
