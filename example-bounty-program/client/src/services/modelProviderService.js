// Service for transforming and managing model provider data
import { classMapService } from './classMapService';

/**
 * Service for handling model provider data transformation and management
 */
export class ModelProviderService {
  constructor() {
    this.providerDisplayNames = {
      'openai': 'OpenAI',
      'anthropic': 'Anthropic',
      'ollama': 'Open-source (Ollama)',
      'hyperbolic': 'Hyperbolic API',
      'xai': 'xAI'
    };
    
    // Reverse mapping for converting display names back to API names
    this.displayToApiNames = {};
    Object.entries(this.providerDisplayNames).forEach(([apiName, displayName]) => {
      this.displayToApiNames[displayName] = apiName;
    });
  }

  /**
   * Get formatted provider models for UI consumption
   * @param {number} classId - The class ID
   * @param {Object} overrideInfo - Optional override class information
   * @returns {Promise<Object>} Object with provider models in UI format
   */
  async getProviderModels(classId, overrideInfo = null) {
    try {
      let modelData;
      
      // Handle override classes - use template class for models
      if (overrideInfo && overrideInfo.isOverride && overrideInfo.templateClass) {
        const templateClassId = overrideInfo.templateClass.id;
        const templateData = await classMapService.getAvailableModels(templateClassId);
        
        // Use template data but with override class information
        modelData = {
          ...templateData,
          classId: classId,
          className: overrideInfo.name,
          status: 'OVERRIDE'
        };
      } else {
        // Regular class loading
        modelData = await classMapService.getAvailableModels(classId);
      }
      
      if (modelData.error || (modelData.status !== 'ACTIVE' && modelData.status !== 'OVERRIDE')) {
        return {
          providerModels: {},
          classInfo: {
            id: classId,
            name: modelData.className || `Class ${classId}`,
            status: modelData.status || 'UNKNOWN',
            error: modelData.error
          },
          isEmpty: true
        };
      }

      // Transform modelsByProvider into UI-friendly format
      const providerModels = {};
      
      Object.entries(modelData.modelsByProvider).forEach(([provider, models]) => {
        const displayName = this.providerDisplayNames[provider] || provider;
        providerModels[displayName] = models.map(model => model.model);
      });

      return {
        providerModels,
        classInfo: {
          id: modelData.classId,
          name: modelData.className,
          status: modelData.status,
          limits: modelData.limits
        },
        rawModels: modelData.models,
        isEmpty: false
      };
    } catch (error) {
      console.error(`Error getting provider models for class ${classId}:`, error);
      return {
        providerModels: {},
        classInfo: {
          id: classId,
          name: `Class ${classId}`,
          status: 'ERROR',
          error: error.message
        },
        isEmpty: true
      };
    }
  }

  /**
   * Get default model for a provider
   * @param {string} provider - Provider display name
   * @param {Object} providerModels - Provider models object
   * @returns {string|null} Default model name
   */
  getDefaultModel(provider, providerModels) {
    const models = providerModels[provider];
    if (!models || models.length === 0) return null;
    
    // Return first model as default
    return models[0];
  }

  /**
   * Convert display provider name back to API name for manifest generation
   * @param {string} displayName - The display name (e.g., "Open-source (Ollama)")
   * @returns {string} The API name (e.g., "ollama")
   */
  getApiProviderName(displayName) {
    return this.displayToApiNames[displayName] || displayName.toLowerCase();
  }

  /**
   * Convert jury nodes from UI format to rubric format with correct API provider names
   * @param {Array} juryNodes - Array of jury nodes with display provider names
   * @returns {Array} Array of jury configuration for rubric
   */
  convertJuryNodesToRubricFormat(juryNodes) {
    return juryNodes.map((node) => {
      const apiProviderName = this.getApiProviderName(node.provider);
      
      return {
        provider: apiProviderName,
        model: node.model,
        runs: node.runs,
        weight: node.weight
      };
    });
  }
}

// Create singleton instance
export const modelProviderService = new ModelProviderService();
export default modelProviderService;


