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
};

export default apiService;
