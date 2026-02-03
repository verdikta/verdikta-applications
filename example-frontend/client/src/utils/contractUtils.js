// src/utils/contractUtils.js
import { ethers } from 'ethers';

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
export const CONTRACT_ABI = [
  'function evaluations(bytes32 requestId) public view returns (uint256[] likelihoods, string justificationCID)',
  'function setChainlinkToken(address _link)',
  'function setChainlinkOracle(address _oracle)',
  'event RequestAIEvaluation(bytes32 indexed requestId, string[] cids)',
  'event FulfillAIEvaluation(bytes32 indexed requestId, uint256[] likelihoods, string justificationCID)',
  'event ChainlinkRequested(bytes32 indexed id)',
  'event ChainlinkFulfilled(bytes32 indexed id)',
  'function getContractConfig() public view returns (address oracleAddr, address linkAddr, bytes32 jobId, uint256 currentFee)',
  'function getEvaluation(bytes32 _requestId) public view returns (uint256[] memory likelihoods, string memory justificationCID, bool exists)',
  'function requestAIEvaluationWithApproval(string[] memory cids, string memory addendumText, uint256 _alpha, uint256 _maxFee, uint256 _estimatedBaseCost, uint256 _maxFeeBasedScalingFactor, uint64 _requestedClass) public returns (bytes32 requestId)',
  'function maxTotalFee(uint256 requestedMaxOracleFee) public view returns (uint256)',
  'function responseTimeoutSeconds() external view returns (uint256)',
  'function finalizeEvaluationTimeout(bytes32 aggId) external'
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
  if (typeof window === 'undefined' || !window.ethereum) return provider;

  const targetNetwork = getNetworkConfig(networkKey);
  const network = await provider.getNetwork();
  console.log('Current network:', network);
  console.log('Target network:', targetNetwork.name);

  if (network.chainId.toString() !== targetNetwork.chainId.toString()) {
    console.log(`Not on ${targetNetwork.name}, attempting to switch...`);
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: targetNetwork.chainIdHex }],
      });
    } catch (switchError) {
      if (switchError && switchError.code === 4902) {
        await window.ethereum.request({
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
        window.ethereum.removeListener('chainChanged', handleNetworkChange);
        setTimeout(() => resolve(new ethers.BrowserProvider(window.ethereum)), 800);
      };
      window.ethereum.on('chainChanged', handleNetworkChange);
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

export async function checkContractFunding(contract, provider, networkKey = DEFAULT_NET_KEY) {
  try {
    console.log('checkContractFunding called with:', {
      contractExists: !!contract,
      providerExists: !!provider,
      contractAddress: contract?.target,
      networkKey,
    });

    if (!contract || !provider) {
      throw new Error(`Invalid parameters: contract=${!!contract}, provider=${!!provider}`);
    }

    const targetNetwork = getNetworkConfig(networkKey);
    const network = await provider.getNetwork();
    console.log('Current network:', network);
    console.log('Target network:', targetNetwork.name);

    if (network.chainId.toString() !== targetNetwork.chainId.toString()) {
      console.log(`Not on ${targetNetwork.name}, attempting to switch...`);
      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: targetNetwork.chainIdHex }],
        });
      } catch (switchError) {
        if (switchError && switchError.code === 4902) {
          try {
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [{
                chainId: targetNetwork.chainIdHex,
                chainName: targetNetwork.name,
                nativeCurrency: targetNetwork.nativeCurrency,
                rpcUrls: [targetNetwork.rpcUrl],
                blockExplorerUrls: [targetNetwork.explorer],
              }],
            });
          } catch (addError) {
            throw new Error(`Please add ${targetNetwork.name} to MetaMask and try again`);
          }
        }
        throw new Error(`Please switch to ${targetNetwork.name} in MetaMask`);
      }

      const newProvider = new ethers.BrowserProvider(window.ethereum);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const newContract = new ethers.Contract(contract.target, CONTRACT_ABI, await newProvider.getSigner());
      return checkContractFunding(newContract, newProvider, networkKey);
    }

    await debugContract(contract);

    const code = await provider.getCode(contract.target);
    console.log('Contract code at address:', {
      address: contract.target,
      codeExists: code !== '0x',
      codeLength: code.length,
    });
    if (code === '0x') throw new Error(`No contract found at address ${contract.target}`);

    console.log('Calling getContractConfig...');
    const config = await contract.getContractConfig();
    console.log('Contract config received:', config);

    const linkToken = new ethers.Contract(
      config.linkAddr,
      ['function balanceOf(address) view returns (uint256)'],
      provider
    );

    const balance = await linkToken.balanceOf(contract.target);
    const fee = config.currentFee;

    console.log('Contract LINK balance:', ethers.formatEther(balance));
    console.log('Required fee:', ethers.formatEther(fee));

    if (balance < fee) {
      throw new Error(
        `Insufficient LINK tokens. Contract needs at least ${ethers.formatEther(fee)} LINK but has ${ethers.formatEther(balance)} LINK`
      );
    }

    return config;
  } catch (error) {
    console.error('Detailed error in checkContractFunding:', {
      message: error.message,
      code: error.code,
      data: error.data,
      name: error.name,
      stack: error.stack,
      contract: contract?.target,
      provider: provider?.connection?.url,
    });
    throw error;
  }
}

