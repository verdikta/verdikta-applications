// src/utils/contractUtils.js
import { ethers } from 'ethers';
import { selectInjectedProvider } from './injectedProvider';

/* Network config selected by REACT_APP_NETWORK = 'base' | 'base_sepolia' */
const NETWORKS = {
  base: {
    key: 'base',
    name: 'Base Mainnet',
    chainId: 8453,
    chainIdHex: '0x2105',
    rpcUrl: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  base_sepolia: {
    key: 'base_sepolia',
    name: 'Base Sepolia Testnet',
    chainId: 84532,
    chainIdHex: '0x14A34',
    rpcUrl: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  },
};

// Default network from env (used as fallback)
const DEFAULT_NET_KEY = process.env.REACT_APP_NETWORK || 'base_sepolia';

/**
 * Get network configuration by key
 * @param {string} networkKey - 'base' or 'base_sepolia'
 * @returns {Object} Network configuration object
 */
export function getNetworkConfig(networkKey) {
  return NETWORKS[networkKey] || NETWORKS[DEFAULT_NET_KEY] || NETWORKS.base_sepolia;
}

// Export default network for backward compatibility
export const CURRENT_NETWORK = getNetworkConfig(DEFAULT_NET_KEY);

// These exports are deprecated - use getNetworkConfig() instead for dynamic network support
export const RPC_URL = CURRENT_NETWORK.rpcUrl;
export const EXPLORER_URL = CURRENT_NETWORK.explorer;
export const TARGET_CHAIN_ID = CURRENT_NETWORK.chainId;
export const TARGET_CHAIN_ID_HEX = CURRENT_NETWORK.chainIdHex;
export const CHAIN_PARAMS = {
  chainId: TARGET_CHAIN_ID_HEX,
  chainName: CURRENT_NETWORK.name,
  nativeCurrency: CURRENT_NETWORK.nativeCurrency,
  rpcUrls: [RPC_URL],
  blockExplorerUrls: [EXPLORER_URL],
};

// ------------------
// Contract Constants
// ------------------
// ABI of the v2 ReputationAggregator (verdikta-dispatcher, reputationBasedAggregator;
// MIGRATION.md there lists the changes from v1). Arbiters are paid in ETH.
//
// One aggregator serves every jury size: each request carries its own jury,
// Jury {K, M, N, P, timeout} (K drawn, M promoted, N counted, P clustered, the round
// timeout in seconds from the draw), and getJury(aggId) returns a round's. The owner
// bounds requests with maxJury() and maxTimeout() (and tPlus(), which every timeout
// must exceed); a request outside them reverts BadJury. See utils/juryPresets.js.
//
// A request escrows maxTotalFee(maxFee, minFee, withBeacons, K, P) from msg.value, and
// the caller's ethOwed credit covers any shortfall; excess value goes to credit. The jury
// is NOT drawn by the request: the requester (here, the user's wallet) moves the round
// on with drawJury() and promote(); see utils/timeoutUtils.js. Unspent prepay, draw
// and promote rewards are credited to ethOwed and withdrawn with withdrawEth().
//
// getRoundInfo().phase: 1 draw, 2 beacons, 3 commit, 4 closing, 5 reveal, 6 final,
// 7 settled, 8 failed, 9 cancelled. aggId = bytes32(roundId), sequential from 1.
export const CONTRACT_ABI = [
  // request and fees
  'function requestAIEvaluationWithApproval(string[] cids, string addendumText, uint256 alpha, uint256 maxFee, uint256 minFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScalingFactor, uint64 requestedClass, bool withBeacons, (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout) jury) payable returns (bytes32 aggId)',
  'function maxTotalFee(uint256 maxFee, uint256 minFee, bool withBeacons, uint8 K, uint8 P) view returns (uint256)',
  'function maxOracleFee() view returns (uint256)',
  'function ethOwed(address) view returns (uint256)',
  'function withdrawEth()',
  // moving a round on (anyone may call; see timeoutUtils.js for who earns what)
  'function drawJury(bytes32 aggId)',
  'function closeCommits(bytes32 aggId)',
  'function promote(bytes32 aggId)',
  'function settle(bytes32 aggId)',
  'function cancelUnsealed(bytes32 aggId)',
  // reading a round
  'function getRoundInfo(bytes32 aggId) view returns (uint8 phase, uint256 requestBlock, bytes32 sealedHash, uint256 closeBlock, uint256 received, uint256 baseFees, uint256 bonuses, uint256 rewards, uint256 deadline, uint256 windowEnd, uint256 commits, uint256 requestTime)',
  'function getEvaluation(bytes32 aggId) view returns (uint256[] aggregated, string justifications, bool valid)',
  'function isFailed(bytes32 aggId) view returns (bool)',
  'function getJury(bytes32 aggId) view returns (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout)',
  // the owner's bounds on a request's jury
  'function maxJury() view returns (uint8)',
  'function maxTimeout() view returns (uint40)',
  'function tPlus() view returns (uint40)',
  'function revealWindow() view returns (uint40)',
  // events
  'event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)',
  'event RequestFunded(bytes32 indexed aggRequestId, address indexed requester, uint256 fromCredit, uint256 fromValue)',
  'event BeaconStageStarted(bytes32 indexed aggRequestId, uint256 beacons)',
  'event JuryDrawn(bytes32 indexed aggRequestId, address indexed drawer, uint256 reward)',
  'event CommitWindowClosed(bytes32 indexed aggRequestId, uint256 closeBlock)',
  'event CommitPhaseComplete(bytes32 indexed aggRequestId, uint256 promoted)',
  'event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications)',
  'event EvaluationFailed(bytes32 indexed aggRequestId, uint8 phase)',
  'event RoundSettled(bytes32 indexed aggRequestId, bool failed)',
  // RequesterRefunded to address(0) is a credit to the arbiter pool, not a refund
  'event RoundCancelled(bytes32 indexed aggRequestId, uint256 toPool)',
  'event RequesterRefunded(bytes32 indexed aggRequestId, address indexed requester, uint256 amount)',
  'event CommitPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount)',
  'event PoolPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount)',
  'event EthWithdrawn(address indexed payee, uint256 amount)',
  // errors
  'error BadInput()',
  'error BadJury()', // AggregatorLib.checkJury: the request's jury is outside the rules or limits
  'error KeeperNotSet()',
  'error InsufficientPayment()',
  'error BadSelectionCount()',
  'error UnknownRequest()',
  'error WrongPhase()',
  'error TooEarly()',
  'error NotDue()',
  'error SeedExpired()',
  'error DrawExpired()',
  'error OutOfGas()',
  'error NothingOwed()',
  'error EthTransferFailed()',
];

// ------------------
// Helper Functions
// ------------------
export async function debugContract(contract) {
  console.log('Debug contract called with:', {
    contractExists: !!contract,
    contractType: typeof contract,
    contractKeys: contract ? Object.keys(contract) : 'N/A',
  });

  if (!contract) {
    console.error('Contract is undefined or null');
    return;
  }

  try {
    const debugInfo = {
      target: { exists: !!contract.target, value: contract.target, type: typeof contract.target },
      interface: {
        exists: !!contract.interface,
        type: typeof contract.interface,
        functions: contract.interface ? Object.keys(contract.interface.functions || {}) : 'No functions found',
      },
      provider: { exists: !!contract.provider, type: typeof contract.provider },
      signer: { exists: !!contract.signer, type: typeof contract.signer },
    };
    console.log('Contract debug info:', debugInfo);
  } catch (error) {
    console.error('Error in debugContract:', {
      errorMessage: error.message,
      errorType: error.name,
      errorStack: error.stack,
    });
  }
}

/**
 * Ensure MetaMask is on the selected network (Base or Base Sepolia).
 * @param {Object} provider - Ethers provider
 * @param {string} networkKey - Network key ('base' or 'base_sepolia')
 * @returns {Promise<Object>} Updated provider
 */
export async function ensureCorrectNetwork(provider, networkKey = DEFAULT_NET_KEY) {
  const injected = typeof window === 'undefined' ? null : selectInjectedProvider();
  if (!injected) return provider;

  const targetNetwork = getNetworkConfig(networkKey);
  const network = await provider.getNetwork();
  console.log('Current network:', network);
  console.log('Target network:', targetNetwork.name);

  if (network.chainId.toString() !== targetNetwork.chainId.toString()) {
    console.log(`Not on ${targetNetwork.name}, attempting to switch...`);
    try {
      await injected.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: targetNetwork.chainIdHex }],
      });
    } catch (switchError) {
      if (switchError && switchError.code === 4902) {
        await injected.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: targetNetwork.chainIdHex,
            chainName: targetNetwork.name,
            nativeCurrency: targetNetwork.nativeCurrency,
            rpcUrls: [targetNetwork.rpcUrl],
            blockExplorerUrls: [targetNetwork.explorer],
          }],
        });
      } else {
        throw new Error(`Please switch to ${targetNetwork.name} in MetaMask`);
      }
    }

    return new Promise((resolve) => {
      const handleNetworkChange = () => {
        injected.removeListener('chainChanged', handleNetworkChange);
        setTimeout(() => resolve(new ethers.BrowserProvider(injected)), 800);
      };
      injected.on('chainChanged', handleNetworkChange);
    });
  }
  return provider;
}

/** Back-compat alias if other code still calls the old function name. */
export async function switchToBaseSepolia(provider) {
  console.warn('switchToBaseSepolia() is deprecated. Using ensureCorrectNetwork() with dynamic network.');
  return ensureCorrectNetwork(provider);
}

/**
 * Optional: direct RPC provider if you don't want to use an injected wallet.
 * @param {string} networkKey - Network key ('base' or 'base_sepolia')
 * @returns {Object} JSON-RPC provider
 */
export function makeRpcProvider(networkKey = DEFAULT_NET_KEY) {
  const network = getNetworkConfig(networkKey);
  return new ethers.JsonRpcProvider(network.rpcUrl);
}

// NOTE: The former checkContractFunding() helper was removed in the ETH-payment
// migration. It gated requests on the aggregator's LINK balance, but the ETH-funded
// ReputationAggregator holds no LINK for routine operation (arbiters are paid in ETH
// from the requester's escrowed msg.value). The relevant pre-flight check now is the
// requester's own ETH balance vs. maxTotalFee(maxFee, minFee, withBeacons, K, P), done inline
// in RunQuery.

