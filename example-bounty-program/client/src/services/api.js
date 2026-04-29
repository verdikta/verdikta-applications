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
   * Toggle the off-chain `publicSubmissions` flag on a bounty.
   * Requires a personal_sign message from the bounty creator.
   * Server route: PATCH /api/jobs/:jobId/public-submissions
   * payload: { publicSubmissions, message, signature }
   */
  async setPublicSubmissions(jobId, payload) {
    const { data } = await api.patch(`/api/jobs/${jobId}/public-submissions`, payload);
    return data;
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
   * Get a fresh on-chain snapshot for a bounty (ABI-decoded server-side).
   * Authoritative over getJob() — the sync-service cache may lag chain state.
   * Server route: GET /api/jobs/:jobId/onchain-status
   */
  async getOnchainStatus(jobId) {
    const response = await api.get(`/api/jobs/${jobId}/onchain-status`);
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

  /**
   * Trigger an immediate blockchain sync cycle
   */
  async triggerSync() {
    const response = await api.post('/api/jobs/sync/now');
    return response.data;
  },

  /**
   * Directly update a job's status in the backend (admin endpoint)
   */
  async updateJobStatus(jobId, status) {
    const response = await api.patch(`/api/jobs/admin/${jobId}/status`, { status });
    return response.data;
  },

  /**
   * Delete a job that doesn't exist on-chain (admin endpoint)
   */
  async deleteJob(jobId) {
    const response = await api.delete(`/api/jobs/admin/${jobId}`);
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
   * Get download URLs for a submission. For the bounty creator, this marks
   * the archive as retrieved and starts the 7-day countdown. For non-creators
   * (only allowed when the bounty has publicSubmissions=true), the response
   * is a read-only public view that does not affect the archive lifetime.
   * @param {string|number} jobId
   * @param {string|number} submissionId
   * @param {string} [posterAddress] - Creator wallet (optional; required for creator-mode access)
   */
  async getSubmissionDownload(jobId, submissionId, posterAddress) {
    const qs = posterAddress ? `?posterAddress=${posterAddress}` : '';
    const response = await api.get(
      `/api/poster/jobs/${jobId}/submissions/${submissionId}/download${qs}`
    );
    return response.data;
  },

  /**
   * Get an inline preview of a previewable submission file. For text formats
   * (.md/.txt/.json/.csv) the response carries inline `content`. For PDF, the
   * response carries metadata only and the frontend embeds the file via
   * getSubmissionFileUrl(). This endpoint never starts the 7-day countdown.
   * Auth: creator always; anyone when publicSubmissions=true.
   * @param {string|number} jobId
   * @param {string|number} submissionId
   * @param {string} [posterAddress] - Creator wallet (optional)
   */
  async getSubmissionPreview(jobId, submissionId, posterAddress) {
    const qs = posterAddress ? `?posterAddress=${posterAddress}` : '';
    const response = await api.get(
      `/api/poster/jobs/${jobId}/submissions/${submissionId}/preview${qs}`
    );
    return response.data;
  },

  /**
   * Build the URL to a single file inside a submission's ZIP. Useful for
   * server-to-server consumers and for debugging. Note: this URL is NOT
   * directly usable in <embed src> from the official frontend, because the
   * /file endpoint requires the X-Client-Key auth header which the browser
   * does not attach to <embed>/<iframe> requests. Use getSubmissionFileBlob
   * to fetch the bytes via axios and render with a Blob URL instead.
   * @param {string|number} jobId
   * @param {string|number} submissionId
   * @param {string} filename - Path inside the ZIP (e.g. "submission/foo.pdf")
   * @param {string} [posterAddress]
   */
  getSubmissionFileUrl(jobId, submissionId, filename, posterAddress) {
    const params = new URLSearchParams({ path: filename });
    if (posterAddress) params.set('posterAddress', posterAddress);
    const base = api.defaults.baseURL || '';
    return `${base}/api/poster/jobs/${jobId}/submissions/${submissionId}/file?${params.toString()}`;
  },

  /**
   * Fetch a single file out of a submission's ZIP as a Blob. Uses the axios
   * client so auth headers (X-Client-Key for the frontend, X-Bot-API-Key for
   * bots) are attached automatically. Wrap the result with URL.createObjectURL
   * for use in <embed>/<iframe>, and call URL.revokeObjectURL on cleanup.
   * Currently only .pdf paths are accepted server-side.
   * @returns {Promise<Blob>}
   */
  async getSubmissionFileBlob(jobId, submissionId, filename, posterAddress) {
    const params = { path: filename };
    if (posterAddress) params.posterAddress = posterAddress;
    const response = await api.get(
      `/api/poster/jobs/${jobId}/submissions/${submissionId}/file`,
      { params, responseType: 'blob' }
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
  },

  // ============================================================
  //                  VALIDATION ENDPOINTS
  // ============================================================

  /**
   * Validate a job's evaluation package
   * Checks if the evaluation CID is accessible and properly formatted (ZIP with rubric)
   * @param {string|number} jobId - The job ID to validate
   * @returns {Object} - { valid, errors[], warnings[], issues[] }
   */
  async validateJob(jobId) {
    const response = await api.get(`/api/jobs/${jobId}/validate`);
    return response.data;
  },

  /**
   * Pre-validate an evaluation CID before creating a bounty
   * @param {Object} data - { evaluationCid, classId }
   * @returns {Object} - { valid, errors[], warnings[] }
   */
  async validateEvaluationPackage(data) {
    const response = await api.post('/api/jobs/validate', data);
    return response.data;
  },

  // ============================================================
  //                  VERDIKTA AGGREGATOR ENDPOINTS
  // ============================================================

  /**
   * Get full aggregation history for an aggId
   * @param {string} aggId - The aggregation ID (0x + 64 hex chars)
   */
  async getAggHistory(aggId) {
    const response = await api.get(`/api/verdikta/agg-history/${aggId}`, { timeout: 60000 });
    return response.data;
  },

  /**
   * Get full evaluation package details for a bounty
   * @param {string|number} jobId - The bounty/job ID
   */
  async getEvaluationPackage(jobId) {
    const response = await api.get(`/api/jobs/${jobId}/evaluation-package`, { timeout: 60000 });
    return response.data;
  }

};

// Export the axios instance for services that need direct access
export { api };

export default apiService;

