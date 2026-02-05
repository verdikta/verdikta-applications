/**
 * API Service
 * Handles all communication with the backend API
 */

import axios from 'axios';
import { config } from '../config';

const isDev = import.meta.env.DEV;

/*
const api = axios.create({
  baseURL:
    (config && (config.apiBaseUrl || config.apiUrl)) ||  // prefer apiBaseUrl, fall back to old apiUrl
    import.meta.env.VITE_API_BASE_URL ||
    import.meta.env.VITE_API_URL ||
    '/',
  timeout: (config && config.apiTimeout) || 30000,
  headers: { 'Content-Type': 'application/json' }
});
*/

const api = axios.create({
  baseURL: isDev
    ? ''                                      // ← relative in dev: Vite proxy will catch /api/*
    : (config?.apiBaseUrl || config?.apiUrl || '/'),
  timeout: (config && config.apiTimeout) || 30000,
  headers: {
    'Content-Type': 'application/json',
    'X-Client-Key': import.meta.env.VITE_CLIENT_KEY || '',
  }
});

// Optional: small runtime hint
try {
  console.log('[API] baseURL =', api.defaults.baseURL);
  console.log('[API] X-Client-Key =', import.meta.env.VITE_CLIENT_KEY ? 'SET (' + import.meta.env.VITE_CLIENT_KEY.substring(0, 8) + '...)' : 'NOT SET');
} catch {}

// Request interceptor to ensure X-Client-Key is always sent
api.interceptors.request.use(request => {
  const clientKey = import.meta.env.VITE_CLIENT_KEY;
  if (clientKey) {
    request.headers['X-Client-Key'] = clientKey;
  }
  console.log('[API] Request to:', request.url);
  console.log('[API] X-Client-Key in request:', request.headers['X-Client-Key'] ? 'YES (' + request.headers['X-Client-Key'].substring(0,8) + '...)' : 'NO');
  return request;
});

// Request interceptor for logging (debug mode)
if (config && config.enableDebug) {
  api.interceptors.request.use(request => {
    console.log('🌐 API Request:', request.method?.toUpperCase?.(), request.baseURL + request.url);
    return request;
  });

  api.interceptors.response.use(
    response => {
      console.log('✅ API Response:', response.status, response.config?.url);
      return response;
    },
    error => {
      console.error('❌ API Error:', error.response?.status, error.config?.url, error.message);
      return Promise.reject(error);
    }
  );
}

/**
 * API service methods
 */
export const apiService = {
  // ============================================================
  //                    JOB ENDPOINTS (MVP)
  // ============================================================

  /**
   * Resolve and persist on-chain bountyId for a job (server-side RPC)
   * Server route: PATCH /api/jobs/:jobId/bountyId/resolve
   * payload: { creator, rubricCid?, submissionCloseTime, txHash? }
   */
  async resolveJobBountyId(jobId, payload) {
    const { data } = await api.patch(`/api/jobs/${jobId}/bountyId/resolve`, payload);
    return data;
  },

  /**
   * Create a new job with rubric and bounty details
   * Server route: POST /api/jobs/create
   */
  async createJob(jobData) {
    const response = await api.post('/api/jobs/create', jobData);
    return response.data;
  },

  /**
   * List all jobs with optional filters
   */
  async listJobs(filters = {}) {
    const { data } = await api.get('/api/jobs', { params: filters }); 
    return data;
  },

  /**
   * Get job details by ID
   */
  async getJob(jobId, includeRubric = true) {
    const params = includeRubric ? '?includeRubric=true' : '';
    const response = await api.get(`/api/jobs/${jobId}${params}`);
    return response.data;
  },

  /**
   * Get submissions for a job
   */
  async getJobSubmissions(jobId) {
    const response = await api.get(`/api/jobs/${jobId}/submissions`);
    return response.data;
  },

  /**
   * Refresh a submission's status from the blockchain
   * Used after finalization to get the latest on-chain status
   */
  async refreshSubmission(jobId, submissionId) {
    const response = await api.post(`/api/jobs/${jobId}/submissions/${submissionId}/refresh`);
    return response.data;
  },

  /**
   * Cancel a Prepared submission (not yet on-chain)
   */
  async cancelSubmission(jobId, submissionId) {
    const response = await api.delete(`/api/jobs/${jobId}/submissions/${submissionId}`);
    return response.data;
  },

  /**
   * Confirm a submission after on-chain prepareSubmission succeeds.
   * This creates the backend submission record with the correct on-chain submissionId.
   */
  async confirmSubmission(jobId, data) {
    const response = await api.post(`/api/jobs/${jobId}/submissions/confirm`, data);
    return response.data;
  },

  /**
   * Submit work for a job (legacy single file)
   */
  async submitWork(jobId, file, hunterAddress) {
    const formData = new FormData();
    formData.append('files', file);
    formData.append('hunter', hunterAddress);

    const response = await api.post(`/api/jobs/${jobId}/submit`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  },

  /**
   * Submit work for a job (multiple files with descriptions and narrative)
   */
  async submitWorkMultiple(jobId, formData) {
    const response = await api.post(`/api/jobs/${jobId}/submit`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  },

  /**
   * Manually persist on-chain bountyId (used after createBounty tx confirms)
   * Server route: PATCH /api/jobs/:jobId/bountyId
   */
  updateJobBountyId: async (jobId, data) => {
    try {
      const r = await api.patch(`/api/jobs/${jobId}/bountyId`, data);
      return r.data;
    } catch (e) {
      // Fallback if you also support generic PATCH /api/jobs/:id
      if (e.response?.status === 404) {
        const r2 = await api.patch(`/api/jobs/${jobId}`, data);
        return r2.data;
      }
      throw e;
    }
  },

  // ============================================================
  //                    BOUNTY ENDPOINTS (Legacy)
  // ============================================================

  /**
   * Upload rubric to IPFS and get CID
   */
async uploadRubric(rubricJson, classId = 128) {
  try {
    const { data } = await api.post(
      '/api/rubrics',
      { rubric: rubricJson, classId },
      { timeout: 90000 } // IPFS pinning can exceed 30s
    );
    return data;
  } catch (e) {
    const msg = e?.response?.data?.error || e?.message || 'Rubric upload failed';
    throw new Error(msg);
  }
},

  /**
   * List all bounties (legacy reads)
   */
  async listBounties(filters = {}) {
    const params = new URLSearchParams(filters).toString();
    const response = await api.get(`/api/bounties${params ? '?' + params : ''}`);
    return response.data;
  },

  /**
   * Get bounty details by ID (legacy reads)
   */
  async getBounty(bountyId) {
    const response = await api.get(`/api/bounties/${bountyId}`);
    return response.data;
  },

  /**
   * Get submissions for a bounty (legacy reads)
   */
  async getBountySubmissions(bountyId) {
    const response = await api.get(`/api/bounties/${bountyId}/submissions`);
    return response.data;
  },

  // ============================================================
  //                  SUBMISSION ENDPOINTS
  // ============================================================

  /**
   * Upload deliverable file to IPFS (legacy path)
   */
  async uploadDeliverable(bountyId, file) {
    const formData = new FormData();
    formData.append('file', file);

    const response = await api.post(`/api/bounties/${bountyId}/submit`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  },

  /**
   * Get submission details (legacy path)
   */
  async getSubmission(submissionId) {
    const response = await api.get(`/api/submissions/${submissionId}`);
    return response.data;
  },

  // ============================================================
  //                    IPFS ENDPOINTS
  // ============================================================

  /**
   * Fetch content from IPFS via backend
   */
  async fetchFromIPFS(cid) {
    const response = await api.get(`/api/fetch/${cid}`, { responseType: 'text' });
    return response.data;
  },

  /**
   * Validate rubric structure
   */
  async validateRubric(rubric) {
    const response = await api.post('/api/rubrics/validate', { rubric });
    return response.data;
  },

  // ============================================================
  //                   UTILITY ENDPOINTS
  // ============================================================

  /**
   * Get list of available Verdikta classes
   */
  async listClasses(filters = {}) {
    const params = new URLSearchParams(filters).toString();
    const response = await api.get(`/api/classes${params ? '?' + params : ''}`);
    return response.data;
  },

  /**
   * Get specific class details
   */
  async getClass(classId) {
    const response = await api.get(`/api/classes/${classId}`);
    return response.data;
  },

  /**
   * Health check
   */
  async healthCheck() {
    const response = await api.get('/health');
    return response.data;
  },

  // ============================================================
  //                  POSTER (BOUNTY CREATOR) ENDPOINTS
  // ============================================================

  /**
   * Get all bounties created by an address with submission summaries
   * @param {string} address - Creator's wallet address
   * @param {object} options - Query options
   * @param {boolean} options.includeExpired - Include expired archives (default: false)
   */
  async getPosterBounties(address, options = {}) {
    const params = new URLSearchParams();
    if (options.includeExpired) params.append('includeExpired', 'true');
    const queryString = params.toString();
    const response = await api.get(`/api/poster/${address}/bounties${queryString ? '?' + queryString : ''}`);
    return response.data;
  },

  /**
   * Get all submissions across all bounties for a poster (flat list)
   * @param {string} address - Creator's wallet address
   * @param {object} options - Query options
   */
  async getPosterSubmissions(address, options = {}) {
    const params = new URLSearchParams();
    if (options.status) params.append('status', options.status);
    if (options.archiveStatus) params.append('archiveStatus', options.archiveStatus);
    if (options.includeExpired) params.append('includeExpired', 'true');
    if (options.limit) params.append('limit', options.limit);
    if (options.offset) params.append('offset', options.offset);
    const queryString = params.toString();
    const response = await api.get(`/api/poster/${address}/submissions${queryString ? '?' + queryString : ''}`);
    return response.data;
  },

  /**
   * Get submissions for a specific job (poster view)
   * @param {string|number} jobId - The job ID
   * @param {string} posterAddress - Creator's wallet address (for verification)
   * @param {object} options - Query options
   */
  async getPosterJobSubmissions(jobId, posterAddress, options = {}) {
    const params = new URLSearchParams();
    if (posterAddress) params.append('posterAddress', posterAddress);
    if (options.includeExpired) params.append('includeExpired', 'true');
    const queryString = params.toString();
    const response = await api.get(`/api/poster/jobs/${jobId}/submissions${queryString ? '?' + queryString : ''}`);
    return response.data;
  },

  /**
   * Get download URLs for a submission (marks as retrieved, starts 7-day countdown)
   * @param {string|number} jobId - The job ID
   * @param {string|number} submissionId - The submission ID
   * @param {string} posterAddress - Creator's wallet address (required)
   */
  async getSubmissionDownload(jobId, submissionId, posterAddress) {
    if (!posterAddress) {
      throw new Error('posterAddress is required to download submissions');
    }
    const response = await api.get(
      `/api/poster/jobs/${jobId}/submissions/${submissionId}/download?posterAddress=${posterAddress}`
    );
    return response.data;
  },

  /**
   * Get archive status for a submission (without triggering retrieval)
   * @param {string|number} jobId - The job ID
   * @param {string|number} submissionId - The submission ID
   */
  async getSubmissionArchiveStatus(jobId, submissionId) {
    const response = await api.get(`/api/poster/jobs/${jobId}/submissions/${submissionId}/status`);
    return response.data;
  },

  /**
   * Get archival service status (diagnostic)
   */
  async getArchivalStatus() {
    const response = await api.get('/api/archival/status');
    return response.data;
  },

  // ============================================================
  //                  ANALYTICS ENDPOINTS
  // ============================================================

  /**
   * Get combined analytics overview (cached server-side)
   */
  async getAnalyticsOverview() {
    const response = await api.get('/api/analytics/overview');
    return response.data;
  },

  /**
   * Get arbiter availability per class
   */
  async getArbiterAnalytics() {
    const response = await api.get('/api/analytics/arbiters');
    return response.data;
  },

  /**
   * Get bounty statistics
   */
  async getBountyAnalytics() {
    const response = await api.get('/api/analytics/bounties');
    return response.data;
  },

  /**
   * Get submission statistics
   */
  async getSubmissionAnalytics() {
    const response = await api.get('/api/analytics/submissions');
    return response.data;
  },

  /**
   * Get system health information
   */
  async getSystemHealth() {
    const response = await api.get('/api/analytics/system');
    return response.data;
  },

  /**
   * Force refresh analytics cache
   */
  async refreshAnalytics() {
    const response = await api.post('/api/analytics/refresh');
    return response.data;
  },

  // ============================================================
  //                    CLASS ENDPOINTS
  // ============================================================

  /**
   * Get list of available AI classes
   */
  async getClasses(params = {}) {
    const response = await api.get('/api/classes', { params });
    return response.data;
  },

  /**
   * Get details for a specific class
   */
  async getClassById(classId) {
    const response = await api.get(`/api/classes/${classId}`);
    return response.data;
  },

  // ============================================================
  //                    BOT ENDPOINTS
  // ============================================================

  /**
   * Register a new bot/agent
   * @param {Object} data - { name, ownerAddress, description }
   * @returns {Object} - { success, bot, apiKey, warning }
   */
  async registerBot(data) {
    const response = await api.post('/api/bots/register', data);
    return response.data;
  },

  /**
   * Get bot information by ID
   */
  async getBotById(botId) {
    const response = await api.get(`/api/bots/${botId}`);
    return response.data;
  },

  // ============================================================
  //                    RECEIPT ENDPOINTS
  // ============================================================

  /**
   * Get share data for a receipt (amount, agent ID, etc.)
   * @param {number} jobId - The job ID
   * @param {number} submissionId - The submission ID
   * @returns {Object} - { success, amountEth, agentId, agentLabel, title, ... }
   */
  async getReceiptShareData(jobId, submissionId) {
    const response = await api.get(`/r/${jobId}/${submissionId}/share`);
    return response.data;
  }

};

// Export the axios instance for services that need direct access
export { api };

export default apiService;

