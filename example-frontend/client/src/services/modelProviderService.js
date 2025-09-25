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
      'hyperbolic': 'Hyperbolic API'
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
   * Validate model selection against class limits
   * @param {Array} juryNodes - Array of selected jury nodes
   * @param {Object} classInfo - Class information with limits
   * @returns {Object} Validation result with warnings/errors
   */
  validateModelSelection(juryNodes, classInfo) {
    const result = {
      valid: true,
      warnings: [],
      errors: []
    };

    if (!classInfo || !classInfo.limits) {
      return result;
    }

    const limits = classInfo.limits;
    
    // Check panel size (unique models)
    const uniqueModels = new Set(juryNodes.map(node => `${node.provider}/${node.model}`));
    if (uniqueModels.size > limits.max_panel_size) {
      result.errors.push(`Too many unique models selected. Maximum: ${limits.max_panel_size}, Selected: ${uniqueModels.size}`);
      result.valid = false;
    }

    // Check max_no_counts (runs per model)
    const maxRuns = Math.max(...juryNodes.map(node => node.runs || 1));
    if (maxRuns > limits.max_no_counts) {
      result.errors.push(`Too many runs per model. Maximum: ${limits.max_no_counts}, Highest selected: ${maxRuns}`);
      result.valid = false;
    }

    // Warnings for approaching limits
    if (uniqueModels.size === limits.max_panel_size) {
      result.warnings.push(`You've reached the maximum number of unique models (${limits.max_panel_size})`);
    }

    if (maxRuns === limits.max_no_counts) {
      result.warnings.push(`You've reached the maximum runs per model (${limits.max_no_counts})`);
    }

    return result;
  }

  /**
   * Create default jury node for a class
   * @param {number} classId - The class ID
   * @returns {Promise<Object>} Default jury node configuration
   */
  async createDefaultJuryNode(classId) {
    try {
      const { providerModels, classInfo } = await this.getProviderModels(classId);
      
      if (Object.keys(providerModels).length === 0) {
        throw new Error(`No models available for class ${classId}`);
      }

      // Get first provider and its first model
      const firstProvider = Object.keys(providerModels)[0];
      const firstModel = this.getDefaultModel(firstProvider, providerModels);

      return {
        provider: firstProvider,
        model: firstModel,
        runs: 1,
        weight: 1.0,
        id: Date.now()
      };
    } catch (error) {
      console.error(`Error creating default jury node for class ${classId}:`, error);
      // Fallback to a generic node
      return {
        provider: 'Unknown',
        model: 'unknown',
        runs: 1,
        weight: 1.0,
        id: Date.now(),
        error: error.message
      };
    }
  }

  /**
   * Get model details for a specific model
   * @param {string} provider - Provider name
   * @param {string} modelName - Model name
   * @param {Array} rawModels - Raw model data from API
   * @returns {Object|null} Model details
   */
  getModelDetails(provider, modelName, rawModels) {
    if (!rawModels) return null;

    // Convert display name back to API provider name
    const apiProvider = Object.entries(this.providerDisplayNames)
      .find(([key, value]) => value === provider)?.[0] || provider.toLowerCase();

    const model = rawModels.find(m => 
      m.provider === apiProvider && m.model === modelName
    );

    if (!model) return null;

    return {
      provider: model.provider,
      model: model.model,
      contextWindow: model.context_window_tokens,
      supportedFileTypes: model.supported_file_types,
      displayProvider: this.providerDisplayNames[model.provider] || model.provider
    };
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
   * Convert jury nodes from UI format to manifest format with correct API provider names
   * @param {Array} juryNodes - Array of jury nodes with display provider names
   * @returns {Array} Array of AI_NODES with correct API provider names
   */
  convertJuryNodesToManifestFormat(juryNodes) {
    const convertedNodes = juryNodes.map((node) => {
      const apiProviderName = this.getApiProviderName(node.provider);
      console.log(`🔄 Converting provider: "${node.provider}" → "${apiProviderName}"`);
      
      return {
        AI_PROVIDER: apiProviderName,
        AI_MODEL: node.model,
        NO_COUNTS: node.runs,
        WEIGHT: node.weight
      };
    });
    
    console.log('📋 Final AI_NODES for manifest:', convertedNodes);
    return convertedNodes;
  }

  /**
   * Get formatted class information for display
   * @param {number} classId - The class ID
   * @returns {Promise<Object>} Formatted class information
   */
  async getClassDisplayInfo(classId) {
    try {
      const classInfo = await classMapService.getClass(classId);
      
      return {
        id: classInfo.id,
        name: classInfo.name,
        description: classInfo.description,
        status: classInfo.status,
        modelCount: classInfo.models?.length || 0,
        providers: [...new Set(classInfo.models?.map(m => this.providerDisplayNames[m.provider] || m.provider) || [])],
        limits: classInfo.limits,
        deprecation: classInfo.deprecation
      };
    } catch (error) {
      console.error(`Error getting class display info for ${classId}:`, error);
      return {
        id: classId,
        name: `Class ${classId}`,
        status: 'ERROR',
        error: error.message,
        modelCount: 0,
        providers: []
      };
    }
  }
}

// Create singleton instance
export const modelProviderService = new ModelProviderService();
export default modelProviderService;
