import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  PlusCircle,
  Check,
  AlertTriangle,
  Library,
  Save,
  Rocket,
  Lightbulb,
  Clock,
  ChevronRight,
  X,
} from 'lucide-react';
import { useToast } from '../components/Toast';
import { apiService } from '../services/api';
import { modelProviderService } from '../services/modelProviderService';
import { walletService } from '../services/wallet';
import * as rubricStorage from '../services/rubricStorage';
import { getTemplateOptions, getTemplate, createBlankRubric, RUBRIC_DEFAULTS } from '../data/rubricTemplates';
import ClassSelector from '../components/ClassSelector';
import CriterionEditor from '../components/CriterionEditor';
import RubricLibrary from '../components/RubricLibrary';
import './CreateBounty.css';

function CreateBounty({ walletState }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState('');
  const [error, setError] = useState(null);
  const [isSwitchingNetwork, setIsSwitchingNetwork] = useState(false);

  // Class and model selection state
  const [selectedClassId, setSelectedClassId] = useState(RUBRIC_DEFAULTS.classId);
  const [availableModels, setAvailableModels] = useState({});
  const [classInfo, setClassInfo] = useState(null);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelError, setModelError] = useState(null);
  const [rawModels, setRawModels] = useState([]); // Store full model data for details display

  // Jury configuration state
  const [juryNodes, setJuryNodes] = useState([]);
  const [iterations, setIterations] = useState(1);

  // Rubric state - threshold kept separate for form binding, but merged when saving
  const [rubric, setRubric] = useState(() => {
    const blank = createBlankRubric();
    // Don't duplicate threshold/classId in rubric state - we track them separately
    const { threshold: _t, classId: _c, ...rest } = blank;
    return rest;
  });
  const [threshold, setThreshold] = useState(RUBRIC_DEFAULTS.threshold);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [showLibrary, setShowLibrary] = useState(false);
  const [loadedRubricCid, setLoadedRubricCid] = useState(null);

  // Form state (basic info)
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    workProductType: 'Work Product',
    payoutAmount: '0.001',
    ethPriceUSD: 0,
    submissionWindowHours: 1, // Default, for development, to 1 hour.
    deliverableRequirements: {
      format: ['markdown', 'pdf']
    }
  });

  // ---------- helpers ----------
  const messageFromAxios = (err) => {
    const d = err?.response?.data;
    if (d && (d.error || d.details)) return [d.error, d.details].filter(Boolean).join(' – ');
    return err?.message || 'Unknown error';
  };

  const hasAtLeastOneCriterion = () =>
    Array.isArray(rubric.criteria) && rubric.criteria.length > 0;

  const validateWeights = () => {
    const scoredCriteria = (rubric.criteria || []).filter((c) => !c.must);
    const totalWeight = scoredCriteria.reduce((sum, c) => sum + (Number(c.weight) || 0), 0);
    return {
      valid: Math.abs(totalWeight - 1.0) < 0.01,
      totalWeight,
      message:
        totalWeight < 0.99
          ? `Weights sum to ${totalWeight.toFixed(2)} (should be 1.00)`
          : totalWeight > 1.01
          ? `Weights sum to ${totalWeight.toFixed(2)} (should be 1.00)`
          : 'Valid',
    };
  };

  const validateJuryWeights = () => {
    const totalWeight = juryNodes.reduce((sum, node) => sum + (Number(node.weight) || 0), 0);
    return {
      valid: Math.abs(totalWeight - 1.0) < 0.01,
      totalWeight,
      message:
        totalWeight < 0.99
          ? `Jury weights sum to ${totalWeight.toFixed(2)} (should be 1.00)`
          : totalWeight > 1.01
          ? `Jury weights sum to ${totalWeight.toFixed(2)} (should be 1.00)`
          : 'Valid',
    };
  };

  /**
   * Transform rubric for backend/IPFS upload
   * Includes threshold and classId as part of the rubric (source of truth)
   */
  const buildRubricForUpload = () => {
    return {
      version: rubric.version || RUBRIC_DEFAULTS.version,
      title: rubric.title,
      description: rubric.description || '',
      threshold: threshold,           // Include threshold in IPFS
      classId: selectedClassId,       // Include classId in IPFS
      criteria: (rubric.criteria || []).map((criterion) => ({
        id: criterion.id,
        label: criterion.label || criterion.id.replace(/_/g, ' '),
        must: !!criterion.must,
        weight: Number(criterion.weight ?? 0),
        description:
          criterion.instructions ||
          criterion.label ||
          criterion.description ||
          '',
      })),
      forbiddenContent: rubric.forbiddenContent || rubric.forbidden_content || [],
    };
  };

  // ---------- effects ----------
  // Fetch ETH price in USD
  useEffect(() => {
    const fetchEthPrice = async () => {
      try {
        const response = await fetch(
          'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'
        );
        const data = await response.json();
        setFormData((prev) => ({ ...prev, ethPriceUSD: data?.ethereum?.usd || 0 }));
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
        const { providerModels, classInfo, isEmpty, isCustom, rawModels: modelDetails } =
          await modelProviderService.getProviderModels(selectedClassId);

        setClassInfo(classInfo);
        
        // Store raw model data for displaying details
        if (modelDetails && Array.isArray(modelDetails)) {
          setRawModels(modelDetails);
        }

        // Only update availableModels if we got models back
        // This preserves the dropdown options when switching to a custom class with no models
        const hasModels = !isEmpty && Object.keys(providerModels).length > 0;
        if (hasModels) {
          setAvailableModels(providerModels);
        }

        // For custom classes, preserve the existing jury configuration
        // The assumption is that models from the previously selected standard class
        // are supported by the custom class
        if (isCustom) {
          console.log(`[CreateBounty] Using custom class ${selectedClassId} - preserving existing jury configuration`);
          // Don't update jury nodes - keep the configuration from the previous standard class
          return;
        }

        // If we have jury nodes, update them with models from the new class
        if (juryNodes.length > 0 && hasModels) {
          // Update existing jury nodes to use models from the new class
          const updatedNodes = juryNodes.map(node => {
            const providers = Object.keys(providerModels);
            // Try to keep the same provider if it exists in the new class
            const providerExists = providers.includes(node.provider);
            const newProvider = providerExists ? node.provider : providers[0];
            const newModel = providerModels[newProvider]?.[0] || '';
            
            return {
              ...node,
              provider: newProvider,
              model: newModel
            };
          });
          setJuryNodes(updatedNodes);
          console.log('[CreateBounty] Updated jury nodes with models from new class');
        } 
        // Initialize with one jury node if we have models and no nodes exist yet
        else if (hasModels && juryNodes.length === 0) {
          const firstProvider = Object.keys(providerModels)[0];
          const firstModel = providerModels[firstProvider][0];
          setJuryNodes([
            {
              provider: firstProvider,
              model: firstModel,
              runs: 1,
              weight: 1.0,
              id: Date.now(),
            },
          ]);
          console.log('[CreateBounty] Initialized first jury node');
        }
      } catch (err) {
        console.error('[CreateBounty] Error loading models:', err);
        setModelError(err.message);
      } finally {
        setIsLoadingModels(false);
      }
    };

    loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClassId]);

  // ---------- jury node management ----------
  const addJuryNode = () => {
    const providers = Object.keys(availableModels);
    if (providers.length === 0) {
      console.warn('No providers available for selected class');
      return;
    }
    const firstProvider = providers[0];
    const firstModel = availableModels[firstProvider]?.[0] || '';

    setJuryNodes((prev) => [
      ...prev,
      {
        provider: firstProvider,
        model: firstModel,
        runs: 1,
        weight: 1.0,
        id: Date.now(),
      },
    ]);
  };

  const updateJuryNode = (id, field, value) => {
    setJuryNodes((prev) =>
      prev.map((node) => {
        if (node.id === id) {
          const updated = { ...node, [field]: value };
          if (field === 'provider' && availableModels[value]) {
            updated.model = availableModels[value][0] || '';
          }
          return updated;
        }
        return node;
      })
    );
  };

  const removeJuryNode = (id) => {
    setJuryNodes((prev) => prev.filter((node) => node.id !== id));
  };

  // ---------- model details helpers ----------
  /**
   * Get detailed information for a specific model
   */
  const getModelDetails = (provider, modelName) => {
    if (!rawModels || rawModels.length === 0) return null;

    // Convert display provider name back to API name
    const apiProvider = modelProviderService.getApiProviderName(provider);
    
    const model = rawModels.find(m => 
      m.provider === apiProvider && m.model === modelName
    );

    return model || null;
  };

  /**
   * Format supported file types into user-friendly categories
   */
  const formatSupportedFileTypes = (fileTypes) => {
    if (!fileTypes || fileTypes.length === 0) {
      return ['Text files'];
    }

    const categories = new Set();
    
    fileTypes.forEach(type => {
      if (type.includes('text/') || type.includes('rtf') || type.includes('word') || type.includes('document')) {
        categories.add('📄 Text & Documents');
      }
      if (type.includes('pdf')) {
        categories.add('📑 PDF');
      }
      if (type.includes('image/')) {
        categories.add('🖼️ Images');
      }
      if (type.includes('audio/')) {
        categories.add('🔊 Audio');
      }
      if (type.includes('video/')) {
        categories.add('🎥 Video');
      }
      if (type.includes('json') || type.includes('csv') || type.includes('xml')) {
        categories.add('📊 Data Files');
      }
    });

    return Array.from(categories);
  };

  // ---------- class selection ----------
  const handleClassSelect = (classId) => {
    setSelectedClassId(classId);
    // Don't clear jury nodes - keep the configuration
  };

  // ---------- templates ----------
  const handleTemplateSelect = (e) => {
    const templateKey = e.target.value;
    setSelectedTemplate(templateKey);

    if (!templateKey) {
      // Reset to blank
      const blank = createBlankRubric();
      setRubric({
        version: blank.version,
        title: blank.title,
        description: '',
        criteria: blank.criteria,
        forbiddenContent: blank.forbiddenContent,
      });
      setThreshold(RUBRIC_DEFAULTS.threshold);
      setSelectedClassId(RUBRIC_DEFAULTS.classId);
      setLoadedRubricCid(null);
      return;
    }

    const template = getTemplate(templateKey);
    if (template) {
      // Load all values from template (threshold and classId are in the template now)
      setRubric({
        version: template.version,
        title: template.title,
        description: template.description || '',
        criteria: template.criteria,
        forbiddenContent: template.forbiddenContent || template.forbidden_content || [],
      });
      setThreshold(template.threshold ?? RUBRIC_DEFAULTS.threshold);
      setSelectedClassId(template.classId ?? RUBRIC_DEFAULTS.classId);
      setFormData((prev) => ({ ...prev, title: template.title }));
      setLoadedRubricCid(null);
    }
  };

  // ---------- rubric criteria helpers ----------
  const addCriterion = (must = false) => {
    const newCriterion = {
      id: `criterion_${Date.now()}`,
      label: '',
      must: !!must,
      weight: must ? 0.0 : 0.2,
      instructions: '',
    };
    setRubric((prev) => ({ ...prev, criteria: [...(prev.criteria || []), newCriterion] }));
  };

  const updateCriterion = (index, updatedCriterion) => {
    setRubric((prev) => ({
      ...prev,
      criteria: (prev.criteria || []).map((c, i) => (i === index ? updatedCriterion : c)),
    }));
  };

  const removeCriterion = (index) => {
    setRubric((prev) => ({
      ...prev,
      criteria: (prev.criteria || []).filter((_, i) => i !== index),
    }));
  };

  // ---------- save rubric to IPFS + cache in localStorage ----------
  const handleSaveRubric = async () => {
    if (!walletState.isConnected) { toast.warning('Please connect your wallet first'); return; }
    if (!rubric.title.trim()) { toast.warning('Please enter a rubric title'); return; }
    if (!hasAtLeastOneCriterion()) { toast.warning('Please add at least one criterion'); return; }

    const validation = validateWeights();
    if (!validation.valid) { toast.warning(`Invalid weights: ${validation.message}`); return; }

    try {
      setLoading(true);
      setLoadingText('Saving rubric to IPFS…');
      setError(null);

      // Build complete rubric with threshold and classId for IPFS (source of truth)
      const rubricForUpload = buildRubricForUpload();
      
      console.log('📤 Uploading rubric to IPFS:', {
        title: rubricForUpload.title,
        threshold: rubricForUpload.threshold,
        classId: rubricForUpload.classId,
        criteriaCount: rubricForUpload.criteria.length
      });

      const response = await apiService.uploadRubric(rubricForUpload, selectedClassId);

      if (!response?.success) {
        throw new Error(response?.error || 'Failed to upload rubric');
      }

      const rubricCid = response.rubricCid;
      if (!rubricCid) throw new Error('Upload returned no rubricCid');

      // Cache in localStorage for fast library display
      // The IPFS content is the source of truth; this is just an index
      const cacheEntry = {
        cid: rubricCid,
        title: rubricForUpload.title,
        description: rubricForUpload.description,
        threshold: rubricForUpload.threshold,
        classId: rubricForUpload.classId,
        criteriaCount: rubricForUpload.criteria.length,
        createdAt: Date.now(),
        creator: walletState.address,
      };

      try {
        rubricStorage.saveRubric(walletState.address, cacheEntry);
      } catch (e) {
        // Don't block on localStorage failure - IPFS upload succeeded
        console.warn('[rubricStorage] Cache failed:', e?.message || e);
      }

      toast.success(`Rubric saved! CID: ${rubricCid.substring(0, 12)}...`);
      setLoadedRubricCid(rubricCid);
    } catch (err) {
      const msg = messageFromAxios(err);
      console.error('Error saving rubric:', msg, err?.response?.data);
      setError(msg);
      toast.error(`Failed to save rubric: ${msg}`);
    } finally {
      setLoading(false);
      setLoadingText('');
    }
  };

  // ---------- load rubric from library (IPFS is source of truth) ----------
  const handleLoadRubric = (loadedRubric) => {
    // loadedRubric comes from RubricLibrary, which fetched from IPFS
    // IPFS content is the source of truth for threshold and classId
    
    console.log('📥 Loading rubric from library:', {
      title: loadedRubric.title,
      threshold: loadedRubric.threshold,
      classId: loadedRubric.classId,
      cid: loadedRubric.cid
    });

    setRubric({
      version: loadedRubric.version || RUBRIC_DEFAULTS.version,
      title: loadedRubric.title,
      description: loadedRubric.description || '',
      criteria: loadedRubric.criteria || [],
      forbiddenContent: loadedRubric.forbiddenContent || loadedRubric.forbidden_content || [],
    });
    
    // Read threshold and classId from IPFS content (source of truth)
    // Fall back to defaults if not present (for old rubrics)
    setThreshold(loadedRubric.threshold ?? RUBRIC_DEFAULTS.threshold);
    setSelectedClassId(loadedRubric.classId ?? RUBRIC_DEFAULTS.classId);
    setLoadedRubricCid(loadedRubric.cid);
    setShowLibrary(false);
    
    toast.success(`Loaded rubric: ${loadedRubric.title} (Threshold: ${loadedRubric.threshold ?? RUBRIC_DEFAULTS.threshold}%)`);
  };

  // ---------- submit (create bounty) ----------
  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!walletState.isConnected) { toast.warning('Please connect your wallet first'); return; }
    if (!formData.title.trim()) { toast.warning('Please enter a job title'); return; }
    if (!formData.description.trim()) { toast.warning('Please enter a job description'); return; }
    if (!formData.payoutAmount || parseFloat(formData.payoutAmount) <= 0) {
      toast.warning('Please enter a valid payout amount'); return;
    }
    if (!rubric.title.trim()) { toast.warning('Please create or load a rubric'); return; }
    if (!hasAtLeastOneCriterion()) { toast.warning('Please add at least one criterion'); return; }

    const validation = validateWeights();
    if (!validation.valid) { toast.warning(`Invalid rubric weights: ${validation.message}`); return; }
    if (juryNodes.length === 0) { toast.warning('Please add at least one jury node'); return; }

    const juryValidation = validateJuryWeights();
    if (!juryValidation.valid) { toast.warning(`Invalid jury weights: ${juryValidation.message}`); return; }

    try {
      setLoading(true);
      setLoadingText('Creating job on backend…');
      setError(null);

      // best-effort network info
      try {
        const provider = walletService.getProvider?.();
        const net = provider && (await provider.getNetwork());
        console.log('[Network]', { chainId: Number(net?.chainId) });
      } catch {}

      // 1) Create job in backend
      // Build rubric with threshold/classId included
      const rubricForBackend = buildRubricForUpload();

      const apiResponse = await apiService.createJob({
        title: formData.title,
        description: formData.description,
        workProductType: formData.workProductType,
        creator: walletState.address,
        bountyAmount: parseFloat(formData.payoutAmount),
        bountyAmountUSD: parseFloat(formData.payoutAmount) * (formData.ethPriceUSD || 0),
        threshold,
        ...(loadedRubricCid ? { rubricCid: loadedRubricCid } : { rubricJson: rubricForBackend }),
        classId: selectedClassId,
        juryNodes: juryNodes.map((n) => ({
          provider: n.provider,
          model: n.model,
          runs: n.runs,
          weight: n.weight,
        })),
        iterations,
        submissionWindowHours: parseInt(formData.submissionWindowHours, 10),
      });

      if (!apiResponse?.success) {
        throw new Error(apiResponse?.error || 'Backend job create failed');
      }

      const { job } = apiResponse;
      console.log('✅ Backend job created:', { jobId: job.jobId, rubricCid: job.rubricCid });

      // 2) On-chain create
      // Pass the primaryCid (evaluation package) to the contract, not just the rubricCid
      // The primaryCid contains the full evaluation package with jury config, rubric reference, etc.
      setLoadingText('Waiting for wallet / creating on-chain…');
      const { getContractService } = await import('../services/contractService');
      const contractService = getContractService();
      if (!contractService.isConnected()) await contractService.connect();

      const contractResult = await contractService.createBounty({
        evaluationCid: job.primaryCid,  // The evaluation package CID, not just the rubric
        classId: selectedClassId,
        threshold,
        bountyAmountEth: parseFloat(formData.payoutAmount),
        submissionWindowHours: parseInt(formData.submissionWindowHours, 10),
      });

      if (!contractResult?.success || contractResult?.bountyId == null) {
        throw new Error('On-chain create returned no bountyId');
      }
      console.log('✅ On-chain bounty created:', contractResult);

      // 3) Persist bountyId to backend
      setLoadingText('Finalizing…');
      await apiService.updateJobBountyId(job.jobId, {
        bountyId: contractResult.bountyId,
        txHash: contractResult.txHash,
        blockNumber: contractResult.blockNumber,
      });

      toast.success(`Bounty #${contractResult.bountyId} created successfully!`);

      navigate(`/bounty/${job.jobId}`);
    } catch (err) {
      const msg = messageFromAxios(err);
      console.error('❌ Create flow failed:', msg, err?.response?.data);
      setError(msg);
      toast.error(`Failed to create bounty: ${msg}`);
    } finally {
      setLoading(false);
      setLoadingText('');
    }
  };

  return (
    <div className="create-bounty">
      <div className="page-header">
        <h1><PlusCircle size={28} className="inline-icon" /> Create New Bounty</h1>
        <p>Define evaluation criteria and lock ETH in escrow</p>
      </div>

      {error && (
        <div className="alert alert-error">
          <p>{error}</p>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <div className="steps-indicator">
        <div
          className={`step clickable ${step === 1 ? 'active' : step > 1 ? 'completed' : ''}`}
          onClick={() => setStep(1)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && setStep(1)}
        >
          <span className="step-number">{step > 1 ? <Check size={16} /> : '1'}</span>
          <span className="step-label">Basic Info</span>
        </div>
        <div
          className={`step clickable ${step === 2 ? 'active' : step > 2 ? 'completed' : ''}`}
          onClick={() => setStep(2)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && setStep(2)}
        >
          <span className="step-number">{step > 2 ? <Check size={16} /> : '2'}</span>
          <span className="step-label">Rubric</span>
        </div>
        <div
          className={`step clickable ${step === 3 ? 'active' : ''}`}
          onClick={() => setStep(3)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && setStep(3)}
        >
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
                onChange={(e) => setFormData((prev) => ({ ...prev, title: e.target.value }))}
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
                onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
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
                onChange={(e) => setFormData((prev) => ({ ...prev, workProductType: e.target.value }))}
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
                  onChange={(e) => setFormData((prev) => ({ ...prev, payoutAmount: e.target.value }))}
                  placeholder="0.1"
                  step="0.001"
                  min="0"
                  required
                />
                {formData.payoutAmount && formData.ethPriceUSD > 0 && (
                  <small className="helper-text">
                    ≈ ${(parseFloat(formData.payoutAmount) * (formData.ethPriceUSD || 0)).toFixed(2)} USD
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
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, submissionWindowHours: e.target.value }))
                  }
                  placeholder="168"
                  min="1"
                  required
                />
                <small className="helper-text">
                  {formData.submissionWindowHours && (
                    <>
                      {Math.floor(formData.submissionWindowHours / 24)} days,{' '}
                      {formData.submissionWindowHours % 24} hours 
                    </>
                  )}
                </small>
              </div>
            </div>

            <div className="form-actions">
              <button type="button" onClick={() => setStep(2)} className="btn btn-primary">
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
                className="btn btn-secondary btn-with-icon"
              >
                <Library size={16} /> Load from Library
              </button>

              <div className="form-group inline">
                <label htmlFor="template">Or start from template:</label>
                <select id="template" value={selectedTemplate} onChange={handleTemplateSelect}>
                  <option value="">Blank Rubric</option>
                  {getTemplateOptions().map((option) => (
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
                onChange={(e) => setRubric((prev) => ({ ...prev, title: e.target.value }))}
                placeholder="e.g., Technical Blog Post Quality Rubric"
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="rubricDescription">Rubric Description</label>
              <textarea
                id="rubricDescription"
                value={rubric.description}
                onChange={(e) => setRubric((prev) => ({ ...prev, description: e.target.value }))}
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
                onChange={(e) => setThreshold(parseInt(e.target.value, 10) || 0)}
                min="0"
                max="100"
                required
              />
              <small className="helper-text">
                The minimum weighted score a submission must achieve to win the bounty.
                For example, a 70% threshold means the submission's weighted criteria scores
                must average at least 70% (and all must-pass criteria must pass).
              </small>
            </div>

            <div className="criteria-section">
              <div className="criteria-explanation">
                <h4>Understanding Criteria Types</h4>
                <div className="criteria-types">
                  <div className="criteria-type">
                    <strong>Weighted Criteria</strong>
                    <p>Scored from 0-100% and contribute to the final score based on their weight. Example: "Writing Quality" with 0.4 weight contributes 40% to the total score.</p>
                  </div>
                  <div className="criteria-type">
                    <strong>Must-Pass Criteria</strong>
                    <p>Binary pass/fail checks. If any must-pass criterion fails, the entire submission fails regardless of other scores. Example: "No plagiarism" or "Includes required sections".</p>
                  </div>
                </div>
                <p className="weight-note">
                  <strong>Note:</strong> Weighted criteria weights must sum to 1.0 (100%). Must-pass criteria have no weight.
                </p>
              </div>

              <div className="section-header">
                <h3>Evaluation Criteria</h3>
                <button
                  type="button"
                  onClick={() => addCriterion(false)}
                  className="btn btn-sm btn-secondary"
                  title="Add a criterion that contributes to the weighted score"
                >
                  + Add Weighted Criterion
                </button>
                <button
                  type="button"
                  onClick={() => addCriterion(true)}
                  className="btn btn-sm btn-secondary"
                  title="Add a pass/fail criterion that must be satisfied"
                >
                  + Add Must-Pass Criterion
                </button>
              </div>

              {(rubric.criteria || []).map((criterion, index) => (
                <CriterionEditor
                  key={criterion.id}
                  criterion={criterion}
                  index={index}
                  onChange={(updated) => updateCriterion(index, updated)}
                  onRemove={() => removeCriterion(index)}
                  canRemove={(rubric.criteria || []).length > 1}
                />
              ))}

              {(rubric.criteria || []).length === 0 && (
                <div className="empty-state">
                  <p>No criteria yet. Add at least one criterion to evaluate submissions.</p>
                </div>
              )}

              <div className="weight-validation">
                {validateWeights().valid ? (
                  <span className="valid"><Check size={14} className="inline-icon" /> Weights sum to 1.00</span>
                ) : (
                  <span className="invalid"><AlertTriangle size={14} className="inline-icon" /> {validateWeights().message}</span>
                )}
              </div>
            </div>

            <div className="form-actions">
              <button type="button" onClick={() => setStep(1)} className="btn btn-secondary">
                ← Back
              </button>

              <button
                type="button"
                onClick={handleSaveRubric}
                className="btn btn-secondary btn-with-icon"
                disabled={loading || !hasAtLeastOneCriterion() || !validateWeights().valid}
              >
                <Save size={16} /> Save Rubric to Library
              </button>

              <button
                type="button"
                onClick={() => setStep(3)}
                className="btn btn-primary"
                disabled={!validateWeights().valid || (rubric.criteria || []).length === 0}
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

            <div className="jury-explanation">
              <h4>How the AI Jury Works</h4>
              <p>
                Your submission will be evaluated by a panel of AI models. Each jury node represents
                one AI model that will score the submission against your rubric. The final score is
                a weighted average of all jury node scores.
              </p>
            </div>

            <div className="form-group">
              <label>Verdikta Class</label>
              <small className="helper-text" style={{ display: 'block', marginBottom: '0.5rem' }}>
                Classes define which AI models are available and their configuration limits.
                Different classes have different models optimized for various evaluation types.
              </small>
              <ClassSelector selectedClassId={selectedClassId} onClassSelect={handleClassSelect} />
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
                  title="Add another AI model to the evaluation panel"
                >
                  + Add Jury Node
                </button>
              </div>

              <div className="jury-fields-explanation">
                <div className="field-hint">
                  <strong>Provider/Model:</strong> The AI service and specific model to use for evaluation.
                </div>
                <div className="field-hint">
                  <strong>Runs:</strong> How many times this model evaluates the submission. Multiple runs are averaged for more consistent scoring.
                </div>
                <div className="field-hint">
                  <strong>Weight:</strong> This node's influence on the final score. All jury node weights should sum to 1.0.
                </div>
              </div>

              {juryNodes.map((node) => (
                <div key={node.id} className="jury-node">
                  <div className="form-row">
                    <div className="form-group">
                      <label>Provider</label>
                      <select
                        value={node.provider}
                        onChange={(e) => updateJuryNode(node.id, 'provider', e.target.value)}
                        title="AI service provider (e.g., Anthropic, OpenAI)"
                      >
                        {Object.keys(availableModels).map((provider) => (
                          <option key={provider} value={provider}>
                            {provider}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group">
                      <label>Model</label>
                      <select
                        value={node.model}
                        onChange={(e) => updateJuryNode(node.id, 'model', e.target.value)}
                        title="Specific AI model to use for evaluation"
                      >
                        {availableModels[node.provider]?.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group small">
                      <label title="Number of evaluation runs for this model">Runs</label>
                      <input
                        type="number"
                        value={node.runs}
                        onChange={(e) => updateJuryNode(node.id, 'runs', parseInt(e.target.value, 10) || 1)}
                        min="1"
                        title="More runs = more consistent but slower evaluation"
                      />
                    </div>

                    <div className="form-group small">
                      <label title="This node's contribution to the final score (0-1)">Weight</label>
                      <input
                        type="number"
                        value={node.weight}
                        onChange={(e) =>
                          updateJuryNode(node.id, 'weight', parseFloat(e.target.value) || 0)
                        }
                        min="0"
                        step="0.1"
                        title="All weights should sum to 1.0"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={() => removeJuryNode(node.id)}
                      className="btn btn-sm btn-danger"
                      title="Remove this jury node"
                    >
                      ×
                    </button>
                  </div>

                  {/* Inline Model Details */}
                  {(() => {
                    const modelDetails = getModelDetails(node.provider, node.model);
                    if (!modelDetails) return null;

                    const supportedTypes = formatSupportedFileTypes(modelDetails.supported_file_types);
                    const contextWindow = modelDetails.context_window_tokens;

                    return (
                      <div className="model-info-inline">
                        <div className="model-info-item">
                          <span className="info-icon">💾</span>
                          <span className="info-label">Context:</span>
                          <span className="info-value">
                            {contextWindow >= 1000000 
                              ? `${(contextWindow / 1000000).toFixed(1)}M tokens`
                              : contextWindow >= 1000
                              ? `${(contextWindow / 1000).toFixed(0)}K tokens`
                              : `${contextWindow} tokens`}
                          </span>
                        </div>
                        <div className="model-info-item">
                          <span className="info-icon">📎</span>
                          <span className="info-label">Supports:</span>
                          <span className="info-value">
                            {supportedTypes.join(', ')}
                          </span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              ))}

              {juryNodes.length === 0 && (
                <div className="empty-state">
                  <p>No jury nodes configured. Add at least one to evaluate submissions.</p>
                </div>
              )}

              {juryNodes.length > 0 && (
                <div className="weight-validation">
                  {validateJuryWeights().valid ? (
                    <span className="valid"><Check size={14} className="inline-icon" /> Jury weights sum to 1.00</span>
                  ) : (
                    <span className="invalid"><AlertTriangle size={14} className="inline-icon" /> {validateJuryWeights().message}</span>
                  )}
                </div>
              )}
            </div>

            <div className="form-group">
              <label htmlFor="iterations">Evaluation Iterations</label>
              <input
                type="number"
                id="iterations"
                value={iterations}
                onChange={(e) => setIterations(parseInt(e.target.value, 10) || 1)}
                min="1"
                max="10"
                title="Number of complete jury evaluation cycles"
              />
              <small className="helper-text">
                How many times the entire jury panel evaluates the submission.
                Multiple iterations improve quality but increase evaluation time and cost.
                For many cases, 1 iteration is sufficient.
              </small>
            </div>

            <div className="form-actions">
              <button type="button" onClick={() => setStep(2)} className="btn btn-secondary">
                ← Back
              </button>

              <button type="submit" className="btn btn-primary btn-lg btn-with-icon" disabled={loading || juryNodes.length === 0}>
                {loading ? 'Creating...' : <><Rocket size={18} /> Create Bounty</>}
              </button>
            </div>
          </div>
        )}

        {/* Cancel button (always visible) */}
        <div className="form-footer">
          <button type="button" onClick={() => navigate('/')} className="btn btn-text" disabled={loading}>
            Cancel
          </button>
        </div>

        {loading && (
          <div className="loading-status">
            <div className="spinner"></div>
            <p>{loadingText || 'Working…'}</p>
          </div>
        )}
      </form>

      <div className="help-section">
        <h3><Lightbulb size={20} className="inline-icon" /> How Bounty Creation Works</h3>
        <ol>
          <li>Define your requirements (rubric with threshold).</li>
          <li>Set payout amount in ETH.</li>
          <li>Set submission window (example: 7 days / 168 hours).</li>
          <li>Rubric (including threshold for selection) is uploaded to IPFS (immutable).</li>
          <li>Smart contract locks your ETH in escrow.</li>
          <li>Bounty status becomes OPEN - hunters can submit work before deadline.</li>
          <li>After deadline passes, bounty becomes EXPIRED if no winner yet.</li>
          <li>Anyone can close an EXPIRED bounty (if no active evaluations) to return funds to creator.</li>
        </ol>

        <div
          className="info-box"
          style={{
            marginTop: '1.5rem',
            padding: '1rem',
            border: '1px solid #e0e0e0',
            borderRadius: '8px',
            backgroundColor: '#f9f9f9',
          }}
        >
          <h4 style={{ marginTop: 0, marginBottom: '0.75rem', color: '#333' }}><Clock size={18} className="inline-icon" /> Bounty Lifecycle</h4>
          <p style={{ marginBottom: '0.5rem' }}>
            <strong>OPEN:</strong> Bounty is active and accepting submissions before the deadline.
          </p>
          <p style={{ marginBottom: '0.5rem' }}>
            <strong>EXPIRED:</strong> Deadline has passed. Anyone can call <code>closeExpiredBounty()</code> to return funds to you (if no active evaluations are in progress).
          </p>
          <p style={{ marginBottom: '0.5rem' }}>
            <strong>AWARDED:</strong> A submission passed the threshold and the winner has been paid.
          </p>
          <p style={{ marginBottom: 0 }}>
            <strong>CLOSED:</strong> Bounty expired without a winner, and funds have been returned to you.
          </p>
        </div>

        <div
          className="info-box"
          style={{
            marginTop: '1rem',
            padding: '1rem',
            border: '1px solid #fbbf24',
            borderRadius: '8px',
            backgroundColor: '#fffbeb',
          }}
        >
          <h4 style={{ marginTop: 0, marginBottom: '0.75rem', color: '#92400e' }}><AlertTriangle size={18} className="inline-icon" /> Important Notes</h4>
          <p style={{ marginBottom: '0.5rem' }}>
            <strong>No Cancellation:</strong> Once created, you cannot cancel your bounty early. Funds remain in escrow until either a winner is selected OR the deadline passes with no winner.
          </p>
          <p style={{ marginBottom: '0.5rem' }}>
            <strong>Active Evaluations:</strong> If submissions are being evaluated when the deadline passes, the bounty cannot be closed until those evaluations complete.
          </p>
          <p style={{ marginBottom: 0 }}>
            <strong>First Winner Takes All:</strong> The first submission that passes the threshold automatically wins. Plan your deadline and threshold accordingly.
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

