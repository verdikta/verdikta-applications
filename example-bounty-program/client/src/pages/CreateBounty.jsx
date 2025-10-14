import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiService } from '../services/api';
import { modelProviderService } from '../services/modelProviderService';
import * as rubricStorage from '../services/rubricStorage';
import { getTemplateOptions, getTemplate, createBlankRubric, getTemplateThreshold } from '../data/rubricTemplates';
import ClassSelector from '../components/ClassSelector';
import CriterionEditor from '../components/CriterionEditor';
import RubricLibrary from '../components/RubricLibrary';
import './CreateBounty.css';

function CreateBounty({ walletState }) {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Class and model selection state
  const [selectedClassId, setSelectedClassId] = useState(128);
  const [availableModels, setAvailableModels] = useState({});
  const [classInfo, setClassInfo] = useState(null);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelError, setModelError] = useState(null);

  // Jury configuration state
  const [juryNodes, setJuryNodes] = useState([]);
  const [iterations, setIterations] = useState(1);

  // Rubric state
  const [rubric, setRubric] = useState(createBlankRubric());
  const [threshold, setThreshold] = useState(80); // Stored separately - used by smart contract
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [showLibrary, setShowLibrary] = useState(false);
  const [loadedRubricCid, setLoadedRubricCid] = useState(null);

  // Form state (basic info)
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    workProductType: 'Work Product',
    payoutAmount: '',
    ethPriceUSD: 0,
    submissionWindowHours: 24,
    deliverableRequirements: {
      format: ['markdown', 'pdf']
    }
  });

  // Fetch ETH price in USD
  useEffect(() => {
    const fetchEthPrice = async () => {
      try {
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
        const data = await response.json();
        setFormData(prev => ({ ...prev, ethPriceUSD: data.ethereum.usd }));
      } catch (err) {
        console.warn('Failed to fetch ETH price:', err);
      }
    };
    fetchEthPrice();
  }, []);

  // Load models when class changes
  useEffect(() => {
    const loadModels = async () => {
      setIsLoadingModels(true);
      setModelError(null);
      
      try {
        const { providerModels, classInfo, isEmpty } = await modelProviderService.getProviderModels(selectedClassId);
        
        setAvailableModels(providerModels);
        setClassInfo(classInfo);

        // Initialize with one jury node if we have models
        if (!isEmpty && Object.keys(providerModels).length > 0 && juryNodes.length === 0) {
          const firstProvider = Object.keys(providerModels)[0];
          const firstModel = providerModels[firstProvider][0];
          
          setJuryNodes([{
            provider: firstProvider,
            model: firstModel,
            runs: 1,
            weight: 1.0,
            id: Date.now()
          }]);
        }
      } catch (err) {
        console.error('Error loading models:', err);
        setModelError(err.message);
      } finally {
        setIsLoadingModels(false);
      }
    };

    loadModels();
  }, [selectedClassId]);

  // Jury node management
  const addJuryNode = () => {
    const availableProviders = Object.keys(availableModels);
    if (availableProviders.length === 0) {
      console.warn('No providers available for selected class');
      return;
    }
    
    const firstProvider = availableProviders[0];
    const firstModel = availableModels[firstProvider]?.[0] || '';
    
    setJuryNodes((prev) => [
      ...prev,
      {
        provider: firstProvider,
        model: firstModel,
        runs: 1,
        weight: 1.0,
        id: Date.now()
      }
    ]);
  };

  const updateJuryNode = (id, field, value) => {
    setJuryNodes((prev) =>
      prev.map((node) => {
        if (node.id === id) {
          const updatedNode = { ...node, [field]: value };
          // If provider changes, default model to the provider's first model
          if (field === 'provider' && availableModels[value]) {
            updatedNode.model = availableModels[value][0] || '';
          }
          return updatedNode;
        }
        return node;
      })
    );
  };

  const removeJuryNode = (id) => {
    setJuryNodes((prev) => prev.filter((node) => node.id !== id));
  };

  // Handle class selection
  const handleClassSelect = (classId) => {
    setSelectedClassId(classId);
    setJuryNodes([]); // Clear jury nodes when class changes
  };

  // Template handling
  const handleTemplateSelect = (e) => {
    const templateKey = e.target.value;
    setSelectedTemplate(templateKey);

    if (!templateKey) {
      setRubric(createBlankRubric());
      setThreshold(80); // Default threshold
      return;
    }

    const template = getTemplate(templateKey);
    const defaultThreshold = getTemplateThreshold(templateKey);
    if (template) {
      setRubric(template);
      setThreshold(defaultThreshold); // Set threshold separately
      setFormData(prev => ({ ...prev, title: template.title }));
    }
  };

  // Rubric editing functions
  const updateRubricField = (field, value) => {
    setRubric(prev => ({ ...prev, [field]: value }));
  };

  const updateCriterion = (index, updatedCriterion) => {
    setRubric(prev => ({
      ...prev,
      criteria: prev.criteria.map((c, i) => i === index ? updatedCriterion : c)
    }));
  };

  const addCriterion = (must = false) => {
    const newCriterion = {
      id: `criterion_${Date.now()}`,
      label: '',
      must: must,
      weight: must ? 0.0 : 0.20,
      instructions: ''
    };

    setRubric(prev => ({
      ...prev,
      criteria: [...prev.criteria, newCriterion]
    }));
  };

  const removeCriterion = (index) => {
    setRubric(prev => ({
      ...prev,
      criteria: prev.criteria.filter((_, i) => i !== index)
    }));
  };

  // Validation
  const validateWeights = () => {
    const scoredCriteria = rubric.criteria.filter(c => !c.must);
    const totalWeight = scoredCriteria.reduce((sum, c) => sum + (c.weight || 0), 0);
    
    return {
      valid: Math.abs(totalWeight - 1.0) < 0.01,
      totalWeight,
      message: totalWeight < 0.99 ? `Weights sum to ${totalWeight.toFixed(2)} (should be 1.00)` : 
               totalWeight > 1.01 ? `Weights sum to ${totalWeight.toFixed(2)} (should be 1.00)` : 
               'Valid'
    };
  };

  // Transform rubric for backend (maps frontend fields to backend expected fields)
  // Note: Threshold is excluded - it's for smart contract use, not AI evaluation
  const transformRubricForBackend = (rubricData) => {
    const { threshold: _, ...rubricWithoutThreshold } = rubricData; // Remove threshold if present
    return {
      ...rubricWithoutThreshold,
      criteria: rubricWithoutThreshold.criteria.map(criterion => ({
        id: criterion.id,
        must: criterion.must,
        weight: criterion.weight,
        description: criterion.instructions || criterion.label || criterion.description || ''
      }))
    };
  };

  // Save rubric to localStorage + IPFS
  const handleSaveRubric = async () => {
    if (!walletState.isConnected) {
      alert('Please connect your wallet first');
      return;
    }

    // Validate
    if (!rubric.title.trim()) {
      alert('Please enter a rubric title');
      return;
    }

    const validation = validateWeights();
    if (!validation.valid) {
      alert(`Invalid weights: ${validation.message}`);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Transform rubric for backend
      const rubricForBackend = transformRubricForBackend(rubric);

      // Upload to IPFS
      const uploadResult = await apiService.uploadRubric(rubricForBackend, selectedClassId);
      
      // Save to localStorage (keep original format with labels/instructions)
      rubricStorage.saveRubric(walletState.address, {
        cid: uploadResult.rubricCid,
        title: rubric.title,
        threshold: threshold, // Save threshold separately
        rubricJson: rubric
      });

      alert(`✅ Rubric saved!\n\nTitle: ${rubric.title}\nCID: ${uploadResult.rubricCid}\n\nYou can now reuse this rubric for future bounties.`);
      
      setLoadedRubricCid(uploadResult.rubricCid);
    } catch (err) {
      console.error('Error saving rubric:', err);
      setError(err.response?.data?.details || err.message);
      alert(`❌ Failed to save rubric: ${err.response?.data?.details || err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Load rubric from library
  const handleLoadRubric = (rubricJson, cid, savedThreshold) => {
    setRubric(rubricJson);
    setThreshold(savedThreshold || 80); // Load saved threshold or default
    setLoadedRubricCid(cid);
    setSelectedTemplate(''); // Clear template selection
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!walletState.isConnected) {
      alert('Please connect your wallet first');
      return;
    }

    // Validate required fields
    if (!formData.title.trim() || !formData.description.trim() || !formData.payoutAmount) {
      alert('Please fill in all required fields');
      return;
    }

    // Validate jury configuration
    if (juryNodes.length === 0) {
      alert('Please add at least one AI model to the jury');
      return;
    }

    // Validate rubric
    const validation = validateWeights();
    if (!validation.valid) {
      alert(`Invalid rubric weights: ${validation.message}`);
      return;
    }

    if (!rubric.title.trim()) {
      alert('Please enter a rubric title');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Convert jury nodes to rubric format
      const juryConfig = modelProviderService.convertJuryNodesToRubricFormat(juryNodes);

      // Prepare rubric JSON (without threshold - that's for smart contract)
      const rubricJson = {
        version: rubric.version,
        title: rubric.title,
        description: formData.description,
        criteria: rubric.criteria,
        forbidden_content: rubric.forbiddenContent,
        deliverable_requirements: formData.deliverableRequirements,
        jury: juryConfig,
        iterations: iterations
      };

      // Transform for backend (maps instructions → description)
      const rubricForBackend = transformRubricForBackend(rubricJson);

      // Calculate USD value
      const bountyAmountUSD = formData.payoutAmount && formData.ethPriceUSD 
        ? (parseFloat(formData.payoutAmount) * formData.ethPriceUSD).toFixed(2)
        : 0;

      // Create job via API (uploads rubric, creates primary CID, stores in local DB)
      const jobData = {
        title: formData.title,
        description: formData.description,
        workProductType: formData.workProductType || 'Work Product',
        creator: walletState.address,
        bountyAmount: parseFloat(formData.payoutAmount),
        bountyAmountUSD: parseFloat(bountyAmountUSD),
        threshold: threshold,
        rubricJson: rubricForBackend,
        classId: selectedClassId,
        juryNodes: juryNodes,
        iterations: iterations,
        submissionWindowHours: formData.submissionWindowHours || 24
      };

      const result = await apiService.createJob(jobData);
      
      console.log('Job created successfully:', result.job);
      
      alert(`✅ Job Created Successfully!\n\nJob ID: ${result.job.jobId}\nTitle: ${result.job.title}\nBounty: ${result.job.bountyAmount} ETH (~$${result.job.bountyAmountUSD})\nThreshold: ${result.job.threshold}%\nRubric CID: ${result.job.rubricCid}\nPrimary CID: ${result.job.primaryCid}\n\nHunters can now submit work for this job!`);

      // Navigate to home to see the new job
      navigate('/');

    } catch (err) {
      console.error('Error creating job:', err);
      setError(err.response?.data?.details || err.message);
      alert(`❌ Failed to create job: ${err.response?.data?.details || err.message}`);
    } finally {
      setLoading(false);
    }
  };

  if (!walletState.isConnected) {
    return (
      <div className="create-bounty">
        <div className="alert alert-warning">
          <h2>Wallet Not Connected</h2>
          <p>Please connect your wallet to create a bounty.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="create-bounty">
      <div className="create-header">
        <h1>Create New Bounty</h1>
        <p>Define your requirements and lock ETH in escrow</p>
      </div>

      {error && (
        <div className="alert alert-error">
          <p>❌ {error}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="bounty-form">
        <div className="form-section">
          <h2>Bounty Details</h2>
          
          <div className="form-group">
            <label htmlFor="title">Title *</label>
            <input
              id="title"
              type="text"
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              placeholder="e.g., Technical Blog Post on Solidity"
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="description">Description *</label>
            <textarea
              id="description"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="Describe what you want in detail..."
              rows={4}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="workProductType">Work Product Type *</label>
            <select
              id="workProductType"
              value={formData.workProductType}
              onChange={(e) => setFormData({ ...formData, workProductType: e.target.value })}
            >
              <option value="Work Product">General Work Product</option>
              <option value="Blog Post">Blog Post</option>
              <option value="Technical Writing">Technical Writing</option>
              <option value="Code">Source Code</option>
              <option value="Design">Graphic Design</option>
              <option value="Video">Video</option>
              <option value="Data Analysis">Data Analysis</option>
              <option value="Research">Research</option>
            </select>
            <small>Type of work that hunters will submit</small>
          </div>

          <div className="form-group">
            <label htmlFor="payoutAmount">Payout Amount (ETH) *</label>
            <input
              id="payoutAmount"
              type="number"
              step="0.001"
              min="0.001"
              value={formData.payoutAmount}
              onChange={(e) => setFormData({ ...formData, payoutAmount: e.target.value })}
              placeholder="0.1"
              required
            />
            <small>
              Minimum: 0.001 ETH
              {formData.payoutAmount && formData.ethPriceUSD > 0 && (
                <span className="usd-estimate">
                  {' '}≈ ${(parseFloat(formData.payoutAmount) * formData.ethPriceUSD).toFixed(2)} USD
                </span>
              )}
            </small>
          </div>

          <div className="form-group">
            <label htmlFor="submissionWindow">Submission Window (hours) *</label>
            <input
              id="submissionWindow"
              type="number"
              min="1"
              max="720"
              value={formData.submissionWindowHours}
              onChange={(e) => setFormData({ ...formData, submissionWindowHours: parseInt(e.target.value) || 24 })}
              placeholder="24"
              required
            />
            <small>
              How long hunters have to submit work (default: 24 hours, max: 30 days)
            </small>
          </div>
        </div>

        <div className="form-section">
          <h2>Evaluation Criteria</h2>
          <p className="section-description">
            Choose a template or create custom criteria. AI evaluators will use this rubric to judge submissions.
          </p>

          {/* Template Selector */}
          <div className="template-selector-group">
            <div className="form-group">
              <label htmlFor="template">Choose Template</label>
              <select
                id="template"
                value={selectedTemplate}
                onChange={handleTemplateSelect}
              >
                {getTemplateOptions().map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              className="btn-load-library"
              onClick={() => setShowLibrary(true)}
            >
              📁 Load My Rubrics
            </button>
          </div>

          {/* Rubric Title */}
          <div className="form-group">
            <label htmlFor="rubricTitle">Rubric Title *</label>
            <input
              id="rubricTitle"
              type="text"
              value={rubric.title}
              onChange={(e) => updateRubricField('title', e.target.value)}
              placeholder="e.g., Blog Post for Verdikta.org"
              required
            />
            {loadedRubricCid && (
              <small className="rubric-loaded-indicator">
                ✅ Loaded from IPFS: {loadedRubricCid.slice(0, 8)}...
              </small>
            )}
          </div>

          {/* Threshold */}
          <div className="form-group">
            <label htmlFor="threshold">Passing Threshold *</label>
            <div className="threshold-control">
              <input
                id="threshold"
                type="range"
                min="0"
                max="100"
                value={rubric.threshold}
                onChange={(e) => updateRubricField('threshold', parseInt(e.target.value))}
              />
              <input
                type="number"
                min="0"
                max="100"
                value={rubric.threshold}
                onChange={(e) => updateRubricField('threshold', parseInt(e.target.value))}
                className="threshold-number-input"
              />
              <span className="threshold-percent">%</span>
            </div>
            <small>Submissions must score above this to win the bounty</small>
          </div>

          {/* Criteria Editor */}
          <div className="criteria-editor-section">
            <div className="criteria-header">
              <h3>Evaluation Criteria</h3>
              {(() => {
                const validation = validateWeights();
                return (
                  <div className={`weight-validation ${validation.valid ? 'valid' : 'invalid'}`}>
                    {validation.valid ? (
                      <span>✓ Weights: {validation.totalWeight.toFixed(2)}</span>
                    ) : (
                      <span>⚠️ {validation.message}</span>
                    )}
                  </div>
                );
              })()}
            </div>

            <div className="criteria-list-editable">
              {rubric.criteria.map((criterion, index) => (
                <CriterionEditor
                  key={criterion.id}
                  criterion={criterion}
                  onChange={(updated) => updateCriterion(index, updated)}
                  onRemove={() => removeCriterion(index)}
                  canRemove={rubric.criteria.length > 1}
                  index={index}
                />
              ))}
            </div>

            <div className="add-criterion-buttons">
              <button
                type="button"
                className="btn-add-criterion"
                onClick={() => addCriterion(false)}
              >
                + Add Scored Criterion
              </button>
              <button
                type="button"
                className="btn-add-criterion btn-add-must"
                onClick={() => addCriterion(true)}
              >
                + Add Must-Pass Criterion
              </button>
            </div>
          </div>

          {/* Save Rubric Button */}
          <div className="save-rubric-section">
            <button
              type="button"
              className="btn-save-rubric"
              onClick={handleSaveRubric}
              disabled={loading}
            >
              💾 Save Rubric for Later
            </button>
            <small>Save this rubric to reuse it for future bounties</small>
          </div>
        </div>

        <div className="form-section">
          <h2>AI Jury Configuration</h2>
          <p className="section-description">
            Select the AI class and configure which models will evaluate submissions
          </p>
          
          {/* Class Selector */}
          <ClassSelector
            selectedClassId={selectedClassId}
            onClassSelect={handleClassSelect}
            isLoading={isLoadingModels}
            error={modelError}
          />

          {/* Iterations Configuration */}
          <div className="form-group iterations-group">
            <label htmlFor="iterations">
              Number of Iterations
              <span className="tooltip-icon" title="The jury process can be repeated multiple times for more reliable results">ⓘ</span>
            </label>
            <div className="numeric-input">
              <button type="button" onClick={() => setIterations(prev => Math.max(1, prev - 1))}>-</button>
              <input
                type="number"
                id="iterations"
                value={iterations}
                onChange={(e) => setIterations(Math.max(1, parseInt(e.target.value) || 1))}
                min="1"
              />
              <button type="button" onClick={() => setIterations(prev => prev + 1)}>+</button>
            </div>
          </div>

          {/* Jury Table */}
          <div className="jury-configuration">
            <h3>Jury Composition</h3>
            
            <div className="jury-table">
              <div className="jury-table-header">
                <div>Provider</div>
                <div>Model</div>
                <div>Runs</div>
                <div>Weight</div>
                <div></div>
              </div>

              {juryNodes.map((node) => (
                <div key={node.id} className="jury-node">
                  <div>
                    <select
                      value={node.provider}
                      onChange={(e) => updateJuryNode(node.id, 'provider', e.target.value)}
                      disabled={Object.keys(availableModels).length === 0}
                    >
                      {Object.keys(availableModels).length === 0 ? (
                        <option value="">No providers available</option>
                      ) : (
                        Object.keys(availableModels).map((provider) => (
                          <option key={provider} value={provider}>
                            {provider}
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                  <div>
                    <select
                      value={node.model}
                      onChange={(e) => updateJuryNode(node.id, 'model', e.target.value)}
                      disabled={!availableModels[node.provider] || availableModels[node.provider].length === 0}
                    >
                      {!availableModels[node.provider] || availableModels[node.provider].length === 0 ? (
                        <option value="">No models available</option>
                      ) : (
                        availableModels[node.provider].map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                  <div>
                    <input
                      type="number"
                      value={node.runs}
                      onChange={(e) =>
                        updateJuryNode(
                          node.id,
                          'runs',
                          Math.max(1, parseInt(e.target.value) || 1)
                        )
                      }
                      min="1"
                      className="runs-input"
                    />
                  </div>
                  <div>
                    <input
                      type="number"
                      value={node.weight}
                      onChange={(e) =>
                        updateJuryNode(
                          node.id,
                          'weight',
                          Math.min(1, Math.max(0, parseFloat(e.target.value) || 0))
                        )
                      }
                      step="0.1"
                      min="0"
                      max="1"
                      className="weight-input"
                    />
                  </div>
                  <div>
                    <button
                      type="button"
                      className="remove-node"
                      onClick={() => removeJuryNode(node.id)}
                      disabled={juryNodes.length === 1}
                      title="Remove this model"
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}

              <button 
                type="button"
                className="add-node-btn" 
                onClick={addJuryNode}
                disabled={Object.keys(availableModels).length === 0}
                title={Object.keys(availableModels).length === 0 ? 'No models available for selected class' : 'Add another AI model'}
              >
                {Object.keys(availableModels).length === 0 ? 'No Models Available' : '+ Add Another AI Model'}
              </button>
            </div>

            <div className="jury-summary">
              <p><strong>Jury Summary:</strong></p>
              <ul>
                <li>{juryNodes.length} model{juryNodes.length !== 1 ? 's' : ''} configured</li>
                <li>{iterations} iteration{iterations !== 1 ? 's' : ''}</li>
                <li>Total evaluations: {juryNodes.reduce((sum, node) => sum + node.runs, 0) * iterations}</li>
              </ul>
            </div>
          </div>
        </div>

        <div className="form-actions">
          <button
            type="submit"
            disabled={loading}
            className="btn btn-primary btn-lg"
          >
            {loading ? 'Creating Bounty...' : 'Create Bounty'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="btn btn-secondary"
          >
            Cancel
          </button>
        </div>

        {loading && (
          <div className="loading-status">
            <div className="spinner"></div>
            <p>Uploading rubric to IPFS...</p>
          </div>
        )}
      </form>

      <div className="help-section">
        <h3>💡 How Bounty Creation Works</h3>
        <ol>
          <li>Define your requirements (rubric)</li>
          <li>Set payout amount in ETH</li>
          <li>Rubric is uploaded to IPFS (immutable)</li>
          <li>Smart contract locks your ETH in escrow</li>
          <li>24-hour cancellation lock begins</li>
          <li>Hunters can now submit work</li>
        </ol>
      </div>

      {/* Rubric Library Modal */}
      {showLibrary && (
        <RubricLibrary
          walletAddress={walletState.address}
          onLoadRubric={handleLoadRubric}
          onClose={() => setShowLibrary(false)}
        />
      )}
    </div>
  );
}

export default CreateBounty;


