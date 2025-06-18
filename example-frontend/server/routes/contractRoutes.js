const express = require('express');
const router = express.Router();
const { loadContracts, saveContracts, isValidEthereumAddress } = require('../utils/contractsManager');

/**
 * GET /api/contracts
 * Returns the list of contracts
 */
router.get('/', async (req, res) => {
  try {
    const contracts = await loadContracts();
    res.json({
      success: true,
      contracts
    });
  } catch (error) {
    console.error('Error fetching contracts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contracts',
      details: error.message
    });
  }
});

/**
 * PUT /api/contracts
 * Updates the list of contracts
 * Requires an array of contract objects in request body
 */
router.put('/', async (req, res) => {
  try {
    const { contracts } = req.body;
    
    if (!Array.isArray(contracts)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request format. Expected an array of contracts'
      });
    }
    
    // Validate each contract
    for (const contract of contracts) {
      if (!contract.address || !contract.name) {
        return res.status(400).json({
          success: false,
          error: 'Each contract must have an address and name'
        });
      }
      
      if (!isValidEthereumAddress(contract.address)) {
        return res.status(400).json({
          success: false,
          error: `Invalid Ethereum address: ${contract.address}`
        });
      }

      // Validate class
      if (contract.class !== undefined) {
        const contractClass = parseInt(contract.class, 10);
        if (isNaN(contractClass) || contractClass < 0 || contractClass > 99999) {
          return res.status(400).json({
            success: false,
            error: `Invalid class value for ${contract.address}. Must be an integer between 0 and 99999.`
          });
        }
        contract.class = contractClass; // Ensure it's a number
      } else {
        // Default class if not provided during an update (though ideally it should always be present)
        contract.class = 128;
      }
    }
    
    await saveContracts(contracts);
    
    res.json({
      success: true,
      message: 'Contracts updated successfully',
      contracts
    });
  } catch (error) {
    console.error('Error updating contracts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update contracts',
      details: error.message
    });
  }
});

/**
 * POST /api/contracts
 * Adds a new contract to the list
 */
router.post('/', async (req, res) => {
  try {
    const { address, name, class: contractClassInput } = req.body;
    
    if (!address || !name) {
      return res.status(400).json({
        success: false,
        error: 'Contract address and name are required'
      });
    }
    
    if (!isValidEthereumAddress(address)) {
      return res.status(400).json({
        success: false,
        error: `Invalid Ethereum address: ${address}`
      });
    }

    let contractClass = 128;
    if (contractClassInput !== undefined) {
      const parsedClass = parseInt(contractClassInput, 10);
      if (isNaN(parsedClass) || parsedClass < 0 || parsedClass > 99999) {
        return res.status(400).json({
          success: false,
          error: 'Invalid class value. Must be an integer between 0 and 99999.'
        });
      }
      contractClass = parsedClass;
    }
    
    const contracts = await loadContracts();
    
    // Check for duplicate address
    if (contracts.some(c => c.address.toLowerCase() === address.toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: 'Contract with this address already exists'
      });
    }
    
    // Add the new contract
    contracts.push({ address, name, class: contractClass });
    
    await saveContracts(contracts);
    
    res.status(201).json({
      success: true,
      message: 'Contract added successfully',
      contract: { address, name, class: contractClass }
    });
  } catch (error) {
    console.error('Error adding contract:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add contract',
      details: error.message
    });
  }
});

/**
 * DELETE /api/contracts/:address
 * Removes a contract from the list
 */
router.delete('/:address', async (req, res) => {
  try {
    const { address } = req.params;
    
    if (!isValidEthereumAddress(address)) {
      return res.status(400).json({
        success: false,
        error: `Invalid Ethereum address: ${address}`
      });
    }
    
    let contracts = await loadContracts();
    const initialLength = contracts.length;
    
    // Filter out the contract to delete
    contracts = contracts.filter(c => c.address.toLowerCase() !== address.toLowerCase());
    
    // Check if any contract was removed
    if (contracts.length === initialLength) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found'
      });
    }
    
    await saveContracts(contracts);
    
    res.json({
      success: true,
      message: 'Contract removed successfully'
    });
  } catch (error) {
    console.error('Error removing contract:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to remove contract',
      details: error.message
    });
  }
});

module.exports = router; 