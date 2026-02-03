import React, { useState, useEffect } from 'react';
import { toast } from 'react-toastify';
import { signAndSend } from '../utils/signatureUtils';
import '../App.css';

const SERVER_URL = process.env.REACT_APP_SERVER_URL || 'http://localhost:5000';

const Administration = ({ walletAddress, onNavigateToContractManagement }) => {
  const [admins, setAdmins] = useState({ bootstrap: [], regular: [], all: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newAdminAddress, setNewAdminAddress] = useState('');
  const [isAddingAdmin, setIsAddingAdmin] = useState(false);
  const [removingAdmin, setRemovingAdmin] = useState(null);

  // Fetch admins on component mount
  useEffect(() => {
    fetchAdmins();
  }, []);

  const fetchAdmins = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${SERVER_URL}/api/admins`, {
        headers: {
          'x-wallet-address': walletAddress
        }
      });
      const data = await response.json();

      if (data.success) {
        setAdmins(data.admins);
      } else {
        setError(data.error || 'Failed to fetch admins');
        toast.error(data.error || 'Failed to fetch admins');
      }
    } catch (err) {
      console.error('Error fetching admins:', err);
      setError('Failed to connect to server');
      toast.error('Failed to connect to server');
    } finally {
      setLoading(false);
    }
  };

  const handleAddAdmin = async (e) => {
    e.preventDefault();

    if (!newAdminAddress.trim()) {
      toast.error('Admin address is required');
      return;
    }

    // Validate Ethereum address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(newAdminAddress)) {
      toast.error('Invalid Ethereum address format');
      return;
    }

    setIsAddingAdmin(true);

    try {
      await signAndSend(
        'Add Administrator',
        `${SERVER_URL}/api/admins`,
        'POST',
        { newAdminAddress }
      );

      toast.success('Administrator added successfully');
      setNewAdminAddress('');
      await fetchAdmins();
    } catch (err) {
      console.error('Error adding admin:', err);
      if (err.message === 'Signature request was rejected') {
        toast.info('Signature request cancelled');
      } else {
        toast.error(err.message || 'Failed to add administrator');
      }
    } finally {
      setIsAddingAdmin(false);
    }
  };

  const handleRemoveAdmin = async (address) => {
    if (!window.confirm(`Are you sure you want to remove admin ${address}?`)) {
      return;
    }

    setRemovingAdmin(address);

    try {
      await signAndSend(
        'Remove Administrator',
        `${SERVER_URL}/api/admins/${address}`,
        'DELETE',
        {}
      );

      toast.success('Administrator removed successfully');
      await fetchAdmins();
    } catch (err) {
      console.error('Error removing admin:', err);
      if (err.message === 'Signature request was rejected') {
        toast.info('Signature request cancelled');
      } else {
        toast.error(err.message || 'Failed to remove administrator');
      }
    } finally {
      setRemovingAdmin(null);
    }
  };

  return (
    <div className="contract-management-container">
      <h1>Administration</h1>

      {/* Add New Administrator Card */}
      <div className="card add-contract-card">
        <h2>Add New Administrator</h2>
        <form onSubmit={handleAddAdmin} className="form-container">
          <div className="form-group">
            <label htmlFor="adminAddress">Wallet Address:</label>
            <input
              type="text"
              id="adminAddress"
              value={newAdminAddress}
              onChange={(e) => setNewAdminAddress(e.target.value)}
              placeholder="0x..."
              className="input-field"
              disabled={isAddingAdmin}
            />
          </div>
          <button
            type="submit"
            className="button add-button"
            disabled={isAddingAdmin}
          >
            {isAddingAdmin ? 'Adding...' : 'Add Administrator'}
          </button>
          <p style={{ fontSize: '13px', color: '#888', marginTop: '10px' }}>
            💡 Adding an administrator requires a MetaMask signature
          </p>
        </form>
      </div>

      {/* Administrator List Card */}
      <div className="card contract-list-card">
        <h2>Current Administrators</h2>
        {loading ? (
          <p className="loading-message">Loading administrators...</p>
        ) : error ? (
          <p className="error-message">{error}</p>
        ) : admins.all.length === 0 ? (
          <p className="empty-message">No administrators found.</p>
        ) : (
          <>
            {/* Bootstrap Admins */}
            {admins.bootstrap.length > 0 && (
              <div style={{ marginBottom: '30px' }}>
                <h3 style={{ fontSize: '16px', marginBottom: '15px', color: '#0052FF' }}>
                  Bootstrap Administrators
                </h3>
                <p style={{ fontSize: '13px', color: '#888', marginBottom: '15px' }}>
                  These administrators are configured in the server .env file and cannot be removed via the UI.
                </p>
                <ul className="contract-list">
                  {admins.bootstrap.map((admin) => (
                    <li key={admin.address} className="contract-item">
                      <div className="contract-info">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <code className="contract-address">{admin.address}</code>
                          <span
                            style={{
                              fontSize: '11px',
                              padding: '2px 8px',
                              borderRadius: '4px',
                              backgroundColor: '#0052FF',
                              color: 'white',
                              fontWeight: '500'
                            }}
                          >
                            Bootstrap
                          </span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Regular Admins */}
            {admins.regular.length > 0 && (
              <div>
                <h3 style={{ fontSize: '16px', marginBottom: '15px', color: '#28a745' }}>
                  Added Administrators
                </h3>
                <p style={{ fontSize: '13px', color: '#888', marginBottom: '15px' }}>
                  These administrators were added via the Administration page.
                </p>
                <ul className="contract-list">
                  {admins.regular.map((admin) => (
                    <li key={admin.address} className="contract-item">
                      <div className="contract-info">
                        <code className="contract-address">{admin.address}</code>
                        <div style={{ fontSize: '12px', color: '#888', marginTop: '5px' }}>
                          Added by: {admin.addedBy}
                          <br />
                          {admin.addedAt && `On: ${new Date(admin.addedAt).toLocaleString()}`}
                        </div>
                      </div>
                      <div className="contract-actions">
                        <button
                          onClick={() => handleRemoveAdmin(admin.address)}
                          className="delete-button"
                          title="Remove administrator"
                          disabled={removingAdmin === admin.address}
                        >
                          {removingAdmin === admin.address ? '...' : '✕'}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {admins.regular.length === 0 && (
              <p style={{ fontSize: '13px', color: '#888', fontStyle: 'italic' }}>
                No additional administrators have been added yet.
              </p>
            )}
          </>
        )}
      </div>

      {/* Contract Management Link */}
      <div className="card" style={{ textAlign: 'center', padding: '30px' }}>
        <h2>Contract Management</h2>
        <p style={{ marginBottom: '20px', color: '#888' }}>
          Manage blockchain contracts for this application
        </p>
        <button
          onClick={onNavigateToContractManagement}
          className="button"
          style={{ fontSize: '16px', padding: '12px 24px' }}
        >
          Go to Contract Management →
        </button>
      </div>
    </div>
  );
};

export default Administration;
