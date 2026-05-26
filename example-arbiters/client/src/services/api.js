import axios from 'axios';

const api = axios.create({
  baseURL: '/',
  timeout: 15000,
});

export const apiService = {
  async getStatus() {
    const response = await api.get('/api/status');
    return response.data;
  },

  async getHealth() {
    const response = await api.get('/health');
    return response.data;
  },

  // Combined arbiter availability + system health for a network.
  // `network` is the client toggle value (e.g. 'base' | 'base_sepolia');
  // the server normalizes it. Allow extra time for the on-chain enumeration.
  async getAnalyticsOverview(network) {
    const response = await api.get('/api/analytics/overview', {
      params: { network },
      timeout: 60000,
    });
    return response.data;
  },

  // Invalidate the server-side cache for a network so the next read is fresh.
  async refreshAnalytics(network) {
    const response = await api.post('/api/analytics/refresh', null, {
      params: { network },
    });
    return response.data;
  },

  // Core contract addresses + live on-chain configuration for a network.
  // Allow extra time for the on-chain reads (matches analytics overview).
  async getContractsOverview(network) {
    const response = await api.get('/api/contracts/overview', {
      params: { network },
      timeout: 60000,
    });
    return response.data;
  },

  // Invalidate the contracts cache for a network.
  async refreshContracts(network) {
    const response = await api.post('/api/contracts/refresh', null, {
      params: { network },
    });
    return response.data;
  },

  // Arbiters owned by `owner` on `network`, grouped by operator contract, with
  // claimable LINK and per-job stake/lock state. Backs the My Arbiters page.
  // Allows extra time for the on-chain enumeration.
  async getOwnedArbiters(owner, network) {
    const response = await api.get('/api/arbiters/owned', {
      params: { owner, network },
      timeout: 60000,
    });
    return response.data;
  },

  // Arbiters grouped by owner address for the analytics "Arbiters by Owner"
  // table. `data.bonusComplete` is false while the lifetime-bonus event scan is
  // still backfilling — poll until true to see that column populate.
  async getOwnersAnalytics(network) {
    const response = await api.get('/api/analytics/owners', {
      params: { network },
      timeout: 60000,
    });
    return response.data;
  },
};

export default apiService;
