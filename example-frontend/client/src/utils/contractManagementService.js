/**
 * Service for managing contracts via the API
 */

const SERVER_URL = process.env.REACT_APP_SERVER_URL || 'http://localhost:5001';

/**
 * Fetches the list of contracts from the server
 * @param {string} walletAddress - Admin wallet address for authentication
 * @returns {Promise<Array>} Array of contract objects
 */
export const fetchContracts = async (walletAddress = null) => {
  try {
    const headers = {};
    if (walletAddress) {
      headers['x-wallet-address'] = walletAddress;
    }

    const response = await fetch(`${SERVER_URL}/api/contracts`, { headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch contracts: ${response.statusText}`);
    }
    const data = await response.json();
    return data.contracts || [];
  } catch (error) {
    console.error('Error fetching contracts:', error);
    throw error;
  }
};

/**
 * Adds a new contract to the list
 * @param {string} address - Ethereum contract address
 * @param {string} name - User-friendly name for the contract
 * @returns {Promise<Object>} The added contract
 */
export const addContract = async (address, name) => {
  try {
    const response = await fetch(`${SERVER_URL}/api/contracts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ address, name }),
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `Failed to add contract: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.contract;
  } catch (error) {
    console.error('Error adding contract:', error);
    throw error;
  }
};

/**
 * Updates the list of contracts
 * @param {Array} contracts - Array of contract objects
 * @returns {Promise<Array>} Updated array of contracts
 */
export const updateContracts = async (contracts) => {
  try {
    const response = await fetch(`${SERVER_URL}/api/contracts`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ contracts }),
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `Failed to update contracts: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.contracts;
  } catch (error) {
    console.error('Error updating contracts:', error);
    throw error;
  }
};

/**
 * Deletes a contract from the list
 * @param {string} address - Ethereum contract address to delete
 * @returns {Promise<void>}
 */
export const deleteContract = async (address) => {
  try {
    const response = await fetch(`${SERVER_URL}/api/contracts/${address}`, {
      method: 'DELETE',
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `Failed to delete contract: ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error deleting contract:', error);
    throw error;
  }
};

export default {
  fetchContracts,
  addContract,
  updateContracts,
  deleteContract
}; 