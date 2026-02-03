// client/src/hooks/useAdmin.js
import { useState, useEffect } from 'react';

const SERVER_URL = process.env.REACT_APP_SERVER_URL || 'http://localhost:5000';

/**
 * Hook to check if the connected wallet is an admin
 * @param {string} walletAddress - The connected wallet address
 * @returns {Object} { isAdmin, isBootstrap, loading, error, checkAdmin }
 */
export function useAdmin(walletAddress) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [isBootstrap, setIsBootstrap] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const checkAdmin = async (address) => {
    if (!address) {
      setIsAdmin(false);
      setIsBootstrap(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${SERVER_URL}/api/admins/check/${address}`);
      const data = await response.json();

      if (data.success) {
        setIsAdmin(data.isAdmin);
        setIsBootstrap(data.isBootstrap);
      } else {
        setIsAdmin(false);
        setIsBootstrap(false);
      }
    } catch (err) {
      console.error('Error checking admin status:', err);
      setError(err.message);
      setIsAdmin(false);
      setIsBootstrap(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkAdmin(walletAddress);
  }, [walletAddress]);

  return {
    isAdmin,
    isBootstrap,
    loading,
    error,
    checkAdmin: () => checkAdmin(walletAddress)
  };
}

export default useAdmin;
