import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiService } from '../services/api';
import { modelProviderService } from '../services/modelProviderService';
import { walletService } from '../services/wallet';
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
  const [isSwitchingNetwork, setIsSwitchingNetwork] = useState(false);

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
    submissionWindowHours: 168, // Default to 7 days (7 * 24 = 168 hours)
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
      const backendRubric = transformRubricForBackend(rubric);

      // Upload to IPFS via backend API
      const response = await apiService.uploadRubric(backendRubric, selectedClassId);

      if (!response.success) {
        throw new Error(response.error || 'Failed to upload rubric');
      }

      const rubricCid = response.rubricCid;

      // Save to localStorage with metadata
      const rubricMetadata = {
        cid: rubricCid,
        title: rubric.title,
        description: rubric.description,
        criteria: rubric.criteria,
        threshold: threshold,
        classId: selectedClassId,
        createdAt: new Date().toISOString(),
        creator: walletState.address
      };

      rubricStorage.saveRubric(rubricMetadata);

      alert(`✅ Rubric saved successfully!\n\nIPFS CID: ${rubricCid}\n\nYou can now use this rubric to create bounties.`);

      // Optional: navigate to create bounty with this rubric pre-loaded
      setLoadedRubricCid(rubricCid);

    } catch (err) {
      console.error('Error saving rubric:', err);
      setError(err.message);
      alert(`Failed to save rubric: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Load rubric from library
  const handleLoadRubric = (savedRubric) => {
    setRubric({
      title: savedRubric.title,
      description: savedRubric.description,
      criteria: savedRubric.criteria,
      forbidden_content: savedRubric.forbidden_content || []
    });
    setThreshold(savedRubric.threshold || 80);
    setSelectedClassId(savedRubric.classId || 128);
    setLoadedRubricCid(savedRubric.cid);
    setShowLibrary(false);
    alert(`Loaded rubric: ${savedRubric.title}`);
  };

  // Submit form (create job via backend API)
  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!walletState.isConnected) {
      alert('Please connect your wallet first');
      return;
    }

    // Validate form
    if (!formData.title.trim()) {
      alert('Please enter a job title');
      return;
    }

    if (!formData.description.trim()) {
      alert('Please enter a job description');
      return;
    }

    if (!formData.payoutAmount || parseFloat(formData.payoutAmount) <= 0) {
      alert('Please enter a valid payout amount');
      return;
    }

    if (!rubric.title.trim()) {
      alert('Please create or load a rubric');
      return;
    }

    const validation = validateWeights();
    if (!validation.valid) {
      alert(`Invalid rubric weights: ${validation.message}`);
      return;
    }

    if (juryNodes.length === 0) {
      alert('Please add at least one jury node');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Transform rubric for backend
      const backendRubric = transformRubricForBackend(rubric);

      // Create job via API
      const response = await apiService.createJob({
        title: formData.title,
        description: formData.description,
        workProductType: formData.workProductType,
        creator: walletState.address,
        bountyAmount: parseFloat(formData.payoutAmount),
        bountyAmountUSD: parseFloat(formData.payoutAmount) * formData.ethPriceUSD,
        threshold: threshold,
        rubricJson: backendRubric,
        classId: selectedClassId,
        juryNodes: juryNodes.map(node => ({
          provider: node.provider,
          model: node.model,
          runs: node.runs,
          weight: node.weight
        })),
        iterations,
        submissionWindowHours: parseInt(formData.submissionWindowHours)
      });

      if (!response.success) {
        throw new Error(response.error || 'Failed to create job');
      }

      alert(`✅ Job created successfully!\n\nJob ID: ${response.job.jobId}\nRubric CID: ${response.job.rubricCid}\nPrimary CID: ${response.job.primaryCid}`);

      // Navigate to job details
      navigate(`/bounty/${response.job.jobId}`);

    } catch (err) {
      console.error('Error creating job:', err);
      setError(err.message);
      alert(`Failed to create job: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="create-bounty">
      <div className="page-header">
        <h1>Create New Bounty</h1>
        <p>Define evaluation criteria and lock ETH in escrow</p>
      </div>

      {error && (
        <div className="alert alert-error">
          <p>{error}</p>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <div className="steps-indicator">
        <div className={`step ${step === 1 ? 'active' : step > 1 ? 'completed' : ''}`}>
          <span className="step-number">1</span>
          <span className="step-label">Basic Info</span>
        </div>
        <div className={`step ${step === 2 ? 'active' : step > 2 ? 'completed' : ''}`}>
          <span className="step-number">2</span>
          <span className="step-label">Rubric</span>
        </div>
        <div className={`step ${step === 3 ? 'active' : ''}`}>
          <span className="step-number">3</span>
          <span className="step-label">AI Jury</span>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        {/* Step 1: Basic Information */}
        {step === 1 && (
          <div className="form-step">
            <h2>Basic Information</h2>

            <div className="form-group">
              <label htmlFor="title">
                Job Title <span className="required">*</span>
              </label>
              <input
                type="text"
                id="title"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="e.g., Write a technical blog post about React Hooks"
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="description">
                Job Description <span className="required">*</span>
              </label>
              <textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Describe what you're looking for in detail..."
                rows={6}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="workProductType">Work Product Type</label>
              <input
                type="text"
                id="workProductType"
                value={formData.workProductType}
                onChange={(e) => setFormData({ ...formData, workProductType: e.target.value })}
                placeholder="e.g., Blog Post, Code, Design"
              />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="payoutAmount">
                  Payout Amount (ETH) <span className="required">*</span>
                </label>
                <input
                  type="number"
                  id="payoutAmount"
                  value={formData.payoutAmount}
                  onChange={(e) => setFormData({ ...formData, payoutAmount: e.target.value })}
                  placeholder="0.1"
                  step="0.001"
                  min="0"
                  required
                />
                {formData.payoutAmount && formData.ethPriceUSD > 0 && (
                  <small className="helper-text">
                    ≈ ${(parseFloat(formData.payoutAmount) * formData.ethPriceUSD).toFixed(2)} USD
                  </small>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="submissionWindow">
                  Submission Window (hours) <span className="required">*</span>
                </label>
                <input
                  type="number"
                  id="submissionWindow"
                  value={formData.submissionWindowHours}
                  onChange={(e) => setFormData({ ...formData, submissionWindowHours: e.target.value })}
                  placeholder="168"
                  min="1"
                  required
                />
                <small className="helper-text">
                  {formData.submissionWindowHours && (
                    <>
                      {Math.floor(formData.submissionWindowHours / 24)} days, {formData.submissionWindowHours % 24} hours
                      {' '} (Default: 7 days / 168 hours)
                    </>
                  )}
                </small>
              </div>
            </div>

            <div className="form-actions">
              <button
                type="button"
                onClick={() => setStep(2)}
                className="btn btn-primary"
              >
                Next: Create Rubric →
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Rubric Definition */}
        {step === 2 && (
          <div className="form-step">
            <h2>Evaluation Rubric</h2>

            <div className="rubric-actions">
              <button
                type="button"
                onClick={() => setShowLibrary(true)}
                className="btn btn-secondary"
              >
                📚 Load from Library
              </button>

              <div className="form-group inline">
                <label htmlFor="template">Or start from template:</label>
                <select
                  id="template"
                  value={selectedTemplate}
                  onChange={handleTemplateSelect}
                >
                  <option value="">Blank Rubric</option>
                  {getTemplateOptions().map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="rubricTitle">
                Rubric Title <span className="required">*</span>
              </label>
              <input
                type="text"
                id="rubricTitle"
                value={rubric.title}
                onChange={(e) => updateRubricField('title', e.target.value)}
                placeholder="e.g., Technical Blog Post Quality Rubric"
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="rubricDescription">
                Rubric Description
              </label>
              <textarea
                id="rubricDescription"
                value={rubric.description}
                onChange={(e) => updateRubricField('description', e.target.value)}
                placeholder="Describe what this rubric evaluates..."
                rows={3}
              />
            </div>

            <div className="form-group">
              <label htmlFor="threshold">
                Acceptance Threshold (%) <span className="required">*</span>
              </label>
              <input
                type="number"
                id="threshold"
                value={threshold}
                onChange={(e) => setThreshold(parseInt(e.target.value))}
                min="0"
                max="100"
                required
              />
              <small className="helper-text">
                Minimum score required to pass and claim bounty (0-100)
              </small>
            </div>

            <div className="criteria-section">
              <div className="section-header">
                <h3>Evaluation Criteria</h3>
                <button
                  type="button"
                  onClick={() => addCriterion(false)}
                  className="btn btn-sm btn-secondary"
                >
                  + Add Weighted Criterion
                </button>
                <button
                  type="button"
                  onClick={() => addCriterion(true)}
                  className="btn btn-sm btn-secondary"
                >
                  + Add Must-Pass Criterion
                </button>
              </div>

              {rubric.criteria.map((criterion, index) => (
                <CriterionEditor
                  key={criterion.id}
                  criterion={criterion}
                  index={index}
                  onUpdate={(updated) => updateCriterion(index, updated)}
                  onRemove={() => removeCriterion(index)}
                />
              ))}

              {rubric.criteria.length === 0 && (
                <div className="empty-state">
                  <p>No criteria yet. Add at least one criterion to evaluate submissions.</p>
                </div>
              )}

              <div className="weight-validation">
                {validateWeights().valid ? (
                  <span className="valid">✓ Weights sum to 1.00</span>
                ) : (
                  <span className="invalid">⚠ {validateWeights().message}</span>
                )}
              </div>
            </div>

            <div className="form-actions">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="btn btn-secondary"
              >
                ← Back
              </button>

              <button
                type="button"
                onClick={handleSaveRubric}
                className="btn btn-secondary"
                disabled={loading}
              >
                💾 Save Rubric to Library
              </button>

              <button
                type="button"
                onClick={() => setStep(3)}
                className="btn btn-primary"
                disabled={!validateWeights().valid || rubric.criteria.length === 0}
              >
                Next: Configure AI Jury →
              </button>
            </div>
          </div>
        )}

        {/* Step 3: AI Jury Configuration */}
        {step === 3 && (
          <div className="form-step">
            <h2>AI Jury Configuration</h2>

            <div className="form-group">
              <label>Verdikta Class</label>
              <ClassSelector
                selectedClassId={selectedClassId}
                onSelectClass={handleClassSelect}
              />
            </div>

            {modelError && (
              <div className="alert alert-error">
                <p>{modelError}</p>
              </div>
            )}

            <div className="jury-section">
              <div className="section-header">
                <h3>Jury Nodes</h3>
                <button
                  type="button"
                  onClick={addJuryNode}
                  className="btn btn-sm btn-secondary"
                  disabled={isLoadingModels || Object.keys(availableModels).length === 0}
                >
                  + Add Jury Node
                </button>
              </div>

              {juryNodes.map((node) => (
                <div key={node.id} className="jury-node">
                  <div className="form-row">
                    <div className="form-group">
                      <label>Provider</label>
                      <select
                        value={node.provider}
                        onChange={(e) => updateJuryNode(node.id, 'provider', e.target.value)}
                      >
                        {Object.keys(availableModels).map(provider => (
                          <option key={provider} value={provider}>{provider}</option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group">
                      <label>Model</label>
                      <select
                        value={node.model}
                        onChange={(e) => updateJuryNode(node.id, 'model', e.target.value)}
                      >
                        {availableModels[node.provider]?.map(model => (
                          <option key={model} value={model}>{model}</option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group small">
                      <label>Runs</label>
                      <input
                        type="number"
                        value={node.runs}
                        onChange={(e) => updateJuryNode(node.id, 'runs', parseInt(e.target.value))}
                        min="1"
                      />
                    </div>

                    <div className="form-group small">
                      <label>Weight</label>
                      <input
                        type="number"
                        value={node.weight}
                        onChange={(e) => updateJuryNode(node.id, 'weight', parseFloat(e.target.value))}
                        min="0"
                        step="0.1"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={() => removeJuryNode(node.id)}
                      className="btn btn-sm btn-danger"
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}

              {juryNodes.length === 0 && (
                <div className="empty-state">
                  <p>No jury nodes configured. Add at least one to evaluate submissions.</p>
                </div>
              )}
            </div>

            <div className="form-group">
              <label htmlFor="iterations">Evaluation Iterations</label>
              <input
                type="number"
                id="iterations"
                value={iterations}
                onChange={(e) => setIterations(parseInt(e.target.value))}
                min="1"
                max="10"
              />
              <small className="helper-text">
                Number of times to run the entire jury evaluation
              </small>
            </div>

            <div className="form-actions">
              <button
                type="button"
                onClick={() => setStep(2)}
                className="btn btn-secondary"
              >
                ← Back
              </button>

              <button
                type="submit"
                className="btn btn-primary btn-lg"
                disabled={loading || juryNodes.length === 0}
              >
                {loading ? 'Creating...' : '🚀 Create Bounty'}
              </button>
            </div>
          </div>
        )}

        {/* Cancel button (always visible) */}
        <div className="form-footer">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="btn btn-text"
            disabled={loading}
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
          <li>Set submission window (default: 7 days / 168 hours)</li>
          <li>Rubric is uploaded to IPFS (immutable)</li>
          <li>Smart contract locks your ETH in escrow</li>
          <li>Submission window begins - hunters can submit work</li>
          <li>After submission window, anyone can close and return funds if no valid submissions</li>
        </ol>
        
        <div className="info-box" style={{ marginTop: '1.5rem', padding: '1rem', border: '1px solid #e0e0e0', borderRadius: '8px', backgroundColor: '#f9f9f9' }}>
          <h4 style={{ marginTop: 0, marginBottom: '0.75rem', color: '#333' }}>⏰ Cancellation Policy</h4>
          <p style={{ marginBottom: '0.5rem' }}>
            <strong>Creator Early Cancel:</strong> You can cancel your bounty after the submission window passes IF no submissions have been made. This returns your funds.
          </p>
          <p style={{ marginBottom: '0.5rem' }}>
            <strong>Public Expired Close:</strong> After the submission deadline, anyone can close an expired bounty (with no active evaluations) to return funds to you.
          </p>
          <p style={{ marginBottom: 0 }}>
            <strong>Note:</strong> Once submissions exist, the bounty cannot be cancelled until evaluations are complete.
          </p>
        </div>
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

