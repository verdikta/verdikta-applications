/**
 * API Service
 * Handles all communication with the backend API
 */

import axios from 'axios';
import { config } from '../config';

const api = axios.create({
  baseURL:
    (config && (config.apiBaseUrl || config.apiUrl)) ||  // prefer apiBaseUrl, fall back to old apiUrl
    import.meta.env.VITE_API_BASE_URL ||
    import.meta.env.VITE_API_URL ||                          
    '/',
  timeout: (config && config.apiTimeout) || 30000,
  headers: { 'Content-Type': 'application/json' }
});

// Request interceptor for logging (debug mode)
if (config && config.enableDebug) {
  api.interceptors.request.use(request => {
    console.log('🌐 API Request:', request.method.toUpperCase(), request.url);
    return request;
  });

  api.interceptors.response.use(
    response => {
      console.log('✅ API Response:', response.status, response.config.url);
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
   * Create a new job with rubric and bounty details
   */
  async createJob(jobData) {
    const response = await api.post('/api/jobs', jobData);
    return response.data;
  },

  /**
   * List all jobs with optional filters
   */
  async listJobs(filters = {}) {
    const params = new URLSearchParams(filters).toString();
    const response = await api.get(`/api/jobs${params ? '?' + params : ''}`);
    return response.data;
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
   * Submit work for a job (legacy single file)
   */
  async submitWork(jobId, file, hunterAddress) {
    const formData = new FormData();
    formData.append('files', file);
    formData.append('hunter', hunterAddress);

    const response = await api.post(`/api/jobs/${jobId}/submit`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      }
    });
    return response.data;
  },

  /**
   * Submit work for a job (multiple files with descriptions and narrative)
   */
  async submitWorkMultiple(jobId, formData) {
    const response = await api.post(`/api/jobs/${jobId}/submit`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      }
    });
    return response.data;
  },

  // ============================================================
  //                    BOUNTY ENDPOINTS (Legacy)
  // ============================================================

  /**
   * Upload rubric to IPFS and get CID
   */
async uploadRubric(rubricJson, classId = 128) {
  const { data } = await api.post('/api/rubrics', { rubric: rubricJson, classId });
  return data;
},

  /**
   * List all bounties (TODO: Requires contract integration)
   */
  async listBounties(filters = {}) {
    const params = new URLSearchParams(filters).toString();
    const response = await api.get(`/api/bounties${params ? '?' + params : ''}`);
    return response.data;
  },

  /**
   * Get bounty details by ID (TODO: Requires contract integration)
   */
  async getBounty(bountyId) {
    const response = await api.get(`/api/bounties/${bountyId}`);
    return response.data;
  },

  /**
   * Get submissions for a bounty (TODO: Requires contract integration)
   */
  async getBountySubmissions(bountyId) {
    const response = await api.get(`/api/bounties/${bountyId}/submissions`);
    return response.data;
  },

  /**
   * Update ID
   */
updateJobBountyId: async (jobId, data) => {
  // Prefer the more explicit route if your backend provides it:
  try {
    const r = await api.patch(`/api/jobs/${jobId}/bountyId`, data);
    return r.data;
  } catch (e) {
    // Fallback to a generic PATCH if your backend expects the full job payload at /api/jobs/:id
    if (e.response?.status === 404) {
      const r2 = await api.patch(`/api/jobs/${jobId}`, data);
      return r2.data;
    }
    throw e;
  }
},

  // ============================================================
  //                  SUBMISSION ENDPOINTS
  // ============================================================

  /**
   * Upload deliverable file to IPFS
   */
  async uploadDeliverable(bountyId, file) {
    const formData = new FormData();
    formData.append('file', file);

    const response = await api.post(`/api/bounties/${bountyId}/submit`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      }
    });
    return response.data;
  },

  /**
   * Get submission details (TODO: Requires contract integration)
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
    const response = await api.get(`/api/fetch/${cid}`, {
      responseType: 'text' // Get as text, let caller parse
    });
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
  }
};

export default apiService;



