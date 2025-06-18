// src/utils/contractUtils.js

import { ethers } from 'ethers';

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

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_PARAMS = {
  chainId: '0x14A34', // 84532 in hex
  chainName: 'Base Sepolia',
  nativeCurrency: {
    name: 'Ethereum',
    symbol: 'ETH',
    decimals: 18
  },
  rpcUrls: ['https://sepolia.base.org'],
  blockExplorerUrls: ['https://sepolia.basescan.org']
};

// ------------------
// Helper Functions
// ------------------
export async function debugContract(contract) {
  console.log("Debug contract called with:", {
    contractExists: !!contract,
    contractType: typeof contract,
    contractKeys: contract ? Object.keys(contract) : 'N/A'
  });

  if (!contract) {
    console.error("Contract is undefined or null");
    return;
  }

  try {
    const debugInfo = {
      target: {
        exists: !!contract.target,
        value: contract.target,
        type: typeof contract.target
      },
      interface: {
        exists: !!contract.interface,
        type: typeof contract.interface,
        functions: contract.interface ? 
          Object.keys(contract.interface.functions || {}) : 
          'No functions found'
      },
      provider: {
        exists: !!contract.provider,
        type: typeof contract.provider
      },
      signer: {
        exists: !!contract.signer,
        type: typeof contract.signer
      }
    };

    console.log("Contract debug info:", debugInfo);
  } catch (error) {
    console.error("Error in debugContract:", {
      errorMessage: error.message,
      errorType: error.name,
      errorStack: error.stack
    });
  }
}

export async function switchToBaseSepolia(provider) {
  const network = await provider.getNetwork();
  console.log("Current network:", network);

  if (network.chainId.toString() !== BASE_SEPOLIA_CHAIN_ID.toString()) {
    console.log("Not on Base Sepolia, attempting to switch...");
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: BASE_SEPOLIA_PARAMS.chainId }]
      });
    } catch (switchError) {
      if (switchError.code === 4902) {
        try {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [BASE_SEPOLIA_PARAMS]
          });
        } catch (addError) {
          throw new Error('Please add Base Sepolia network to MetaMask and try again');
        }
      }
      throw new Error('Please switch to Base Sepolia network in MetaMask');
    }

    // Wait for network change to complete
    return new Promise((resolve) => {
      const handleNetworkChange = () => {
        window.ethereum.removeListener('chainChanged', handleNetworkChange);
        setTimeout(async () => {
          const newProvider = new ethers.BrowserProvider(window.ethereum);
          resolve(newProvider);
        }, 1000);
      };
      window.ethereum.on('chainChanged', handleNetworkChange);
    });
  }
  return provider;
}

export async function checkContractFunding(contract, provider) {
  try {
    console.log("checkContractFunding called with:", {
      contractExists: !!contract,
      providerExists: !!provider,
      contractAddress: contract?.target
    });

    if (!contract || !provider) {
      throw new Error(`Invalid parameters: contract=${!!contract}, provider=${!!provider}`);
    }

    // Check network and attempt to switch if needed
    const network = await provider.getNetwork();
    console.log("Current network:", network);

    // Compare chainId as strings to avoid BigInt issues
    if (network.chainId.toString() !== BASE_SEPOLIA_CHAIN_ID.toString()) {
      console.log("Not on Base Sepolia, attempting to switch...");
      try {
        // Try to switch to Base Sepolia
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: BASE_SEPOLIA_PARAMS.chainId }]
        });
      } catch (switchError) {
        // This error code indicates that the chain has not been added to MetaMask
        if (switchError.code === 4902) {
          try {
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [BASE_SEPOLIA_PARAMS]
            });
          } catch (addError) {
            throw new Error('Please add Base Sepolia network to MetaMask and try again');
          }
        }
        throw new Error('Please switch to Base Sepolia network in MetaMask');
      }
      
      // Get new provider after network switch
      const newProvider = new ethers.BrowserProvider(window.ethereum);
      // Wait a moment for the network switch to complete
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Create new contract instance with new provider
      const newContract = new ethers.Contract(contract.target, CONTRACT_ABI, await newProvider.getSigner());
      
      // Recursively call with new contract and provider
      return checkContractFunding(newContract, newProvider);
    }

    // Debug contract interface
    await debugContract(contract);
    
    // Verify contract code exists at address
    const code = await provider.getCode(contract.target);
    console.log("Contract code at address:", {
      address: contract.target,
      codeExists: code !== '0x',
      codeLength: code.length
    });

    if (code === '0x') {
      throw new Error(`No contract found at address ${contract.target}`);
    }

    console.log("Calling getContractConfig...");
    const config = await contract.getContractConfig();
    console.log("Contract config received:", config);

    const linkToken = new ethers.Contract(
      config.linkAddr,
      ['function balanceOf(address) view returns (uint256)'],
      provider
    );
    
    const balance = await linkToken.balanceOf(contract.target);
    const fee = config.currentFee;
    
    console.log("Contract LINK balance:", ethers.formatEther(balance));
    console.log("Required fee:", ethers.formatEther(fee));
    
    if (balance < fee) {
      throw new Error(`Insufficient LINK tokens. Contract needs at least ${ethers.formatEther(fee)} LINK but has ${ethers.formatEther(balance)} LINK`);
    }
    
    return config;
  } catch (error) {
    console.error("Detailed error in checkContractFunding:", {
      message: error.message,
      code: error.code,
      data: error.data,
      name: error.name,
      stack: error.stack,
      contract: contract?.target,
      provider: provider?.connection?.url
    });
    throw error;
  }
}
