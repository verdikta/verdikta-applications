import { rubricWeights } from '../utils/rubricWeights';
import { validateBountyWindows } from '../utils/bountyWindows';
import { effectiveBountyAmountEth } from '../utils/effectiveBountyAmount';
import { pastedJsonText } from '../utils/pastedJson';
import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
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
  Eye,
  RefreshCw,
  Settings,
  ChevronDown,
  Upload,
} from 'lucide-react';
import { ethers } from 'ethers';
import { useToast } from '../components/Toast';
import { apiService } from '../services/api';
import { modelProviderService } from '../services/modelProviderService';
import { walletService } from '../services/wallet';
import { getContractService, ORACLE_MAX_ALPHA, ORACLE_MAX_FEE_SCALING, ORACLE_FEE_CEILING_WEI } from '../services/contractService';
import { config } from '../config';
import * as rubricStorage from '../services/rubricStorage';
import { getTemplateOptions, getTemplate, createBlankRubric, RUBRIC_DEFAULTS } from '../data/rubricTemplates';
import ClassSelector from '../components/ClassSelector';
import ClassCoverage from '../components/ClassCoverage';
import CriterionEditor from '../components/CriterionEditor';
import RubricLibrary from '../components/RubricLibrary';
import './CreateBounty.css';

// Creator oracle settings (advanced). Prefilled from config.submissionDefaults (wei) and
// edited as decimal ETH / plain integers. They go into createBounty's `oracle` struct and
// apply to every evaluation of the bounty; hunters cannot change them.
const ORACLE_DEFAULTS = {
  oracleMaxOracleFeeEth: ethers.formatEther(config.submissionDefaults.maxOracleFeeWei),
  oracleAlpha: String(config.submissionDefaults.alpha),
  oracleEstimatedBaseCostEth: ethers.formatEther(config.submissionDefaults.estimatedBaseCostWei),
  oracleMaxFeeBasedScaling: String(config.submissionDefaults.maxFeeBasedScaling),
};
const ORACLE_FEE_CEILING_ETH = ethers.formatEther(ORACLE_FEE_CEILING_WEI);

/**
 * Validate the oracle settings form fields against the contract's bounds.
 * Returns an error string, or null when valid.
 */
function validateOracleSettings(f) {
  let feeWei, baseWei;
  try { feeWei = ethers.parseEther(String(f.oracleMaxOracleFeeEth || '').trim()); }
  catch { return 'Max oracle fee must be a decimal ETH amount (e.g. 0.00002)'; }
  try { baseWei = ethers.parseEther(String(f.oracleEstimatedBaseCostEth || '0').trim() || '0'); }
  catch { return 'Estimated base cost must be a decimal ETH amount (e.g. 0.00001)'; }
  if (feeWei <= 0n) return 'Max oracle fee must be greater than 0';
  if (feeWei > ORACLE_FEE_CEILING_WEI) return `Max oracle fee must be at most ${ORACLE_FEE_CEILING_ETH} ETH (aggregator ceiling)`;
  if (baseWei < 0n) return 'Estimated base cost must be >= 0';
  if (baseWei >= feeWei) return 'Estimated base cost must be below the max oracle fee';
  const alpha = Number(f.oracleAlpha);
  if (!Number.isInteger(alpha) || alpha < 0 || alpha > ORACLE_MAX_ALPHA) return `Alpha must be an integer between 0 and ${ORACLE_MAX_ALPHA}`;
  const scaling = Number(f.oracleMaxFeeBasedScaling);
  if (!Number.isInteger(scaling) || scaling < 1 || scaling > ORACLE_MAX_FEE_SCALING) return `Max fee-based scaling must be an integer between 1 and ${ORACLE_MAX_FEE_SCALING}`;
  return null;
}

function CreateBounty({ walletState }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const reissueId = searchParams.get('clone');
  const [reissueFrom, setReissueFrom] = useState(null);
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
  // From ClassCoverage: false only when the chain says no arbiter can serve the
  // selected class (the server would refuse the bounty), null when unchecked.
  const [classServable, setClassServable] = useState(null);
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

  // Import of a downloaded work-order draft (verdikta-discover). The checking module is loaded lazily on first use
  // because it brings in AJV. Importing sends nothing: the owner still reviews, picks the jury and signs.
  const [imported, setImported] = useState(null);
  const [importErrors, setImportErrors] = useState([]);
  // The buyer preview on the Agents page hands an agent's assessment input or a saved draft over in navigation state,
  // never in the URL. It only prefills the paste box: the owner still imports it, and it is checked here.
  const handedOver = typeof location.state?.workOrderPaste === 'string' ? location.state.workOrderPaste : null;
  const [importPaste, setImportPaste] = useState(handedOver ?? '');
  const [importHandoff, setImportHandoff] = useState(handedOver !== null);
  const [importApi, setImportApi] = useState(null);
  // Drop the handed-over text from the history entry once it has prefilled the box, so a reload does not bring it back.
  useEffect(() => {
    if (location.state?.workOrderPaste !== undefined) navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location, navigate]);

  // Form state (basic info)
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    workProductType: 'Work Product',
    payoutAmount: '0.001',
    ethPriceUSD: 0,
    submissionWindowHours: 1, // Default, for development, to 1 hour.
    targetHunter: '',
    deliverableRequirements: {
      format: ['markdown', 'pdf']
    },
    // Creator approval window (optional)
    // Defaults match the placeholders on the windowed-bounty inputs so the
    // form is submittable as-is once the checkbox is enabled. Users can edit
    // these values; this just avoids the "cannot be zero" validation error
    // when the user trusted what looked like pre-filled values.
    enableApprovalWindow: false,
    creatorPaymentEth: '0.001',
    arbiterPaymentEth: '0.001',
    approvalWindowHours: '0.5',
    // Off-chain visibility flag — creators can opt in to convenient public
    // preview/download of submitted work. CIDs are public regardless; this
    // just surfaces buttons on the website. Revocable later from the bounty
    // details page.
    publicSubmissions: false,
    // Oracle settings (advanced) — creator-chosen, applied to every evaluation.
    ...ORACLE_DEFAULTS,
  });
  // "Oracle settings (advanced)" group is collapsed by default.
  const [showOracleSettings, setShowOracleSettings] = useState(false);

  // ---------- helpers ----------
  const messageFromAxios = (err) => {
    const d = err?.response?.data;
    if (d && (d.error || d.details)) return [d.error, d.details].filter(Boolean).join(' – ');
    return err?.message || 'Unknown error';
  };

  const hasAtLeastOneCriterion = () =>
    Array.isArray(rubric.criteria) && rubric.criteria.length > 0;

  const validateWeights = () => rubricWeights(rubric.criteria);

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
        const response = await fetch('/api/jobs/eth-price');
        const data = await response.json();
        setFormData((prev) => ({ ...prev, ethPriceUSD: data?.usd || 0 }));
      } catch (err) {
        console.warn('Failed to fetch ETH price:', err);
      }
    };
    fetchEthPrice();
  }, []);

  // Re-issue: pre-fill the form from an existing bounty (?clone=<jobId>)
  // Carries over everything (title, description, rubric, jury, payout, approval
  // window) but recomputes a fresh submission window so the new bounty starts now.
  // The user reviews/tweaks and submits through the normal create flow, so the
  // counter-alignment guarantees (one /jobs/create → on-chain createBounty → link)
  // are preserved and the original bounty is left untouched.
  useEffect(() => {
    if (!reissueId) return;
    let cancelled = false;

    const loadSource = async () => {
      try {
        setLoading(true);
        setLoadingText('Loading bounty to re-issue…');
        const resp = await apiService.getJob(reissueId, true);
        const job = resp?.job;
        if (!job) throw new Error('Source bounty not found');
        if (cancelled) return;

        // Basic info — recompute the original submission-window duration fresh from now
        const windowHours =
          job.submissionOpenTime && job.submissionCloseTime
            ? Math.max(1, Math.round((job.submissionCloseTime - job.submissionOpenTime) / 3600))
            : 1;
        const windowSecs = Number(job.creatorAssessmentWindowSize) || 0;
        const hasApprovalWindow = windowSecs > 0;

        setFormData((prev) => ({
          ...prev,
          title: job.title || '',
          description: job.description || '',
          workProductType: job.workProductType || 'Work Product',
          payoutAmount: job.bountyAmount != null ? String(job.bountyAmount) : prev.payoutAmount,
          submissionWindowHours: windowHours,
          targetHunter:
            job.targetHunter && /^0x[a-fA-F0-9]{40}$/.test(job.targetHunter) ? job.targetHunter : '',
          publicSubmissions: !!job.publicSubmissions,
          enableApprovalWindow: hasApprovalWindow,
          creatorPaymentEth:
            job.creatorDeterminationPayment != null
              ? String(job.creatorDeterminationPayment)
              : prev.creatorPaymentEth,
          arbiterPaymentEth:
            job.arbiterDeterminationPayment != null
              ? String(job.arbiterDeterminationPayment)
              : prev.arbiterPaymentEth,
          approvalWindowHours: hasApprovalWindow
            ? String(Math.max(1, Math.round(windowSecs / 3600)))
            : prev.approvalWindowHours,
          // Oracle settings — copied from the source bounty (wei strings on the record)
          ...(job.oracleSettings && job.oracleSettings.maxOracleFee != null ? (() => {
            try {
              return {
                oracleMaxOracleFeeEth: ethers.formatEther(String(job.oracleSettings.maxOracleFee)),
                oracleAlpha: String(job.oracleSettings.alpha ?? prev.oracleAlpha),
                oracleEstimatedBaseCostEth: ethers.formatEther(String(job.oracleSettings.estimatedBaseCost ?? '0')),
                oracleMaxFeeBasedScaling: String(job.oracleSettings.maxFeeBasedScaling ?? prev.oracleMaxFeeBasedScaling),
              };
            } catch { return {}; }
          })() : {}),
        }));
        // Surface the copied oracle settings if they differ from the defaults
        if (job.oracleSettings && job.oracleSettings.maxOracleFee != null) {
          const o = job.oracleSettings;
          const differs =
            String(o.maxOracleFee) !== String(config.submissionDefaults.maxOracleFeeWei) ||
            Number(o.alpha) !== Number(config.submissionDefaults.alpha) ||
            String(o.estimatedBaseCost) !== String(config.submissionDefaults.estimatedBaseCostWei) ||
            Number(o.maxFeeBasedScaling) !== Number(config.submissionDefaults.maxFeeBasedScaling);
          if (differs) setShowOracleSettings(true);
        }

        // Rubric — fetched from IPFS by the server (job.rubricContent). The pinned
        // rubric stores per-criterion instructions under `description`.
        const rc = job.rubricContent;
        if (rc) {
          setRubric({
            version: rc.version || RUBRIC_DEFAULTS.version,
            title: rc.title || job.title || '',
            description: rc.description || '',
            criteria: (rc.criteria || []).map((c, i) => ({
              id: c.id || `criterion_${i}_${Date.now()}`,
              label: c.label || '',
              must: !!c.must,
              weight: Number(c.weight ?? 0),
              instructions: c.instructions || c.description || '',
            })),
            forbiddenContent: rc.forbiddenContent || rc.forbidden_content || [],
          });
          if (rc.threshold != null) setThreshold(rc.threshold);
        } else if (job.threshold != null) {
          setThreshold(job.threshold);
          toast.warning('Could not load the original rubric criteria — please review the Rubric step.');
        }

        // Class + jury. Setting the class triggers the model-load effect, which now
        // preserves each jury node's model when it is still valid for the class.
        if (job.classId != null) setSelectedClassId(job.classId);
        if (Array.isArray(job.juryNodes) && job.juryNodes.length > 0) {
          setJuryNodes(
            job.juryNodes.map((n, i) => ({
              provider: n.provider,
              model: n.model,
              runs: n.runs ?? 1,
              weight: Number(n.weight ?? 0),
              id: `reissue_${i}_${Date.now()}`,
            }))
          );
        }
        if (job.iterations != null) setIterations(job.iterations);

        setReissueFrom(job.jobId ?? reissueId);
      } catch (err) {
        console.error('[Re-issue] Failed to load source bounty:', err);
        toast.error(`Could not load bounty to re-issue: ${err?.message || err}`);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setLoadingText('');
        }
      }
    };

    loadSource();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reissueId]);

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
            // Keep the node's current model if it's still valid for this class
            // (e.g. when re-issuing a bounty on the same class); otherwise fall
            // back to the provider's first available model.
            const newModel =
              providerExists && providerModels[newProvider]?.includes(node.model)
                ? node.model
                : providerModels[newProvider]?.[0] || '';

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
  // A class outside the registry has no model list: classes are permissionless, so
  // its arbiter operators define the identifiers and the jury is typed in freely.
  const isCustomClass = classInfo?.status === 'CUSTOM';

  const addJuryNode = () => {
    const providers = Object.keys(availableModels);
    if (providers.length === 0 && !isCustomClass) {
      console.warn('No providers available for selected class');
      return;
    }
    const firstProvider = isCustomClass ? '' : providers[0];
    const firstModel = isCustomClass ? '' : availableModels[firstProvider]?.[0] || '';

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
          if (field === 'provider' && availableModels[value] && !isCustomClass) {
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
  // ---------- work-order draft import ----------
  const applyImportBytes = async (bytes) => {
    setImportErrors([]);
    try {
      const api = importApi || (await import('../utils/workOrderImport.js'));
      setImportApi(api);
      const result = api.inspectDraftBytes(bytes);
      if (!result.ok) { setImportErrors(result.errors); return; }
      const patch = api.draftToFormPatch(result);
      setImported({ ...result, patch });
      setRubric({ version: RUBRIC_DEFAULTS.version, ...patch.rubric });
      setThreshold(patch.threshold);
      setLoadedRubricCid(null);
      setSelectedTemplate('');
      setFormData((prev) => ({
        ...prev,
        targetHunter: patch.targetHunter,
        title: prev.title.trim() ? prev.title : patch.suggestedTitle,
        description: prev.description.trim() ? prev.description : patch.baseDescription,
      }));
      toast.success('Work-order draft imported. Nothing has been submitted: review every field and choose your jury.');
    } catch (err) {
      setImportErrors([`Could not check the draft: ${err?.message || err}`]);
    }
  };
  const handleDraftFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 256 * 1024) { setImportErrors(['The draft is larger than 256 KB']); return; }
    await applyImportBytes(new Uint8Array(await file.arrayBuffer()));
  };
  // A chat reply's code fences, part labels and prose are dropped; JSON pasted without fences is checked byte for byte.
  const handleDraftPaste = () => applyImportBytes(new TextEncoder().encode(pastedJsonText(importPaste)));
  const restoreDraftValues = () => {
    if (!imported) return;
    setRubric({ version: RUBRIC_DEFAULTS.version, ...imported.patch.rubric });
    setThreshold(imported.patch.threshold);
    setLoadedRubricCid(null);
    setFormData((prev) => ({ ...prev, targetHunter: imported.patch.targetHunter }));
  };
  const removeImport = () => { setImported(null); setImportErrors([]); setImportPaste(''); setImportHandoff(false); };
  // A draft derived from an agent's assessment input can be saved, so the onboarding skill gets exactly these bytes.
  const downloadDerivedDraft = () => {
    if (!imported?.previewText) return;
    const url = URL.createObjectURL(new Blob([imported.previewText], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `work-order-draft-${imported.summary.task_id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // What no longer matches the imported draft. A targeted draft never silently becomes open, and an open one never gains a target.
  const divergence = imported && importApi
    ? importApi.draftDivergence(imported.draft, { rubric: buildRubricForUpload(), threshold, targetHunter: formData.targetHunter })
    : [];
  const networkWarning = Boolean(imported && importApi && importApi.networkMismatch(imported.summary.network, config.network));
  let importedBlock = '', importedBlockError = '';
  if (imported && importApi) {
    try { importedBlock = importApi.composeImportedDescription(imported, formData.description).description.slice(formData.description.length); }
    catch (err) { importedBlockError = err.message; }
  }

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!walletState.isConnected) { toast.warning('Please connect your wallet first'); return; }
    if (!formData.title.trim()) { toast.warning('Please enter a job title'); return; }
    if (!formData.description.trim()) { toast.warning('Please enter a job description'); return; }
    if (imported && divergence.length) {
      toast.warning(`The ${divergence.join(', ')} no longer match the imported work-order draft. Restore the draft values or remove the import.`);
      return;
    }
    if (imported && importedBlockError) { toast.warning(importedBlockError); return; }
    // With an imported draft the description is the owner's words plus the committed work-order block.
    const evaluationDescription = imported && importApi ? importApi.composeImportedDescription(imported, formData.description).description : formData.description;
    // Windowed bounties are funded with max(creator, arbiter) payment; the
    // payout field is hidden in that mode and this derived value is what gets
    // displayed, priced in USD, sent to the API and escrowed on-chain.
    const bountyAmountEth = effectiveBountyAmountEth(formData);
    if (!formData.enableApprovalWindow && bountyAmountEth == null) {
      toast.warning('Please enter a valid payout amount'); return;
    }
    // Parse the submission window ONCE and send this same decimal value to the
    // API and the contract. Previously the guard below used the decimal while
    // the payloads sent parseInt(), so 1.5h passed here and failed server-side.
    const submissionWindowHours = Number(formData.submissionWindowHours);
    const windowError = validateBountyWindows({
      submissionWindowHours,
      approvalWindowHours: formData.approvalWindowHours,
      enableApprovalWindow: formData.enableApprovalWindow,
    });
    if (windowError) { toast.warning(windowError); return; }
    if (!rubric.title.trim()) { toast.warning('Please create or load a rubric'); return; }
    if (!hasAtLeastOneCriterion()) { toast.warning('Please add at least one criterion'); return; }

    const validation = validateWeights();
    if (!validation.valid) { toast.warning(`Invalid rubric weights: ${validation.message}`); return; }
    if (juryNodes.length === 0) { toast.warning('Please add at least one jury node'); return; }
    if (formData.targetHunter && !/^0x[a-fA-F0-9]{40}$/.test(formData.targetHunter)) {
      toast.warning('Target address must be a valid Ethereum address (0x...)'); return;
    }
    if (formData.enableApprovalWindow) {
      if (!formData.creatorPaymentEth || parseFloat(formData.creatorPaymentEth) <= 0) {
        toast.warning('Creator approval payment must be > 0 ETH'); return;
      }
      if (!formData.arbiterPaymentEth || parseFloat(formData.arbiterPaymentEth) <= 0) {
        toast.warning('Arbiter approval payment must be > 0 ETH'); return;
      }
    }

    const juryValidation = validateJuryWeights();
    if (!juryValidation.valid) { toast.warning(`Invalid jury weights: ${juryValidation.message}`); return; }

    const oracleError = validateOracleSettings(formData);
    if (oracleError) { setShowOracleSettings(true); toast.warning(`Oracle settings: ${oracleError}`); return; }
    const oracleSettings = {
      maxOracleFee: String(formData.oracleMaxOracleFeeEth).trim(),          // decimal ETH
      alpha: parseInt(formData.oracleAlpha, 10),
      estimatedBaseCost: String(formData.oracleEstimatedBaseCostEth || '0').trim() || '0', // decimal ETH
      maxFeeBasedScaling: parseInt(formData.oracleMaxFeeBasedScaling, 10),
    };

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
        description: evaluationDescription,
        workProductType: formData.workProductType,
        creator: walletState.address,
        bountyAmount: bountyAmountEth,
        bountyAmountUSD: parseFloat(bountyAmountEth) * (formData.ethPriceUSD || 0),
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
        submissionWindowHours,
        ...(formData.targetHunter ? { targetHunter: formData.targetHunter } : {}),
        ...(formData.enableApprovalWindow ? {
          creatorDeterminationPayment: parseFloat(formData.creatorPaymentEth),
          arbiterDeterminationPayment: parseFloat(formData.arbiterPaymentEth),
          creatorAssessmentWindowHours: parseFloat(formData.approvalWindowHours),
        } : {}),
        publicSubmissions: !!formData.publicSubmissions,
        // Creator oracle settings (decimal ETH accepted; the server normalises to wei)
        oracleMaxOracleFee: oracleSettings.maxOracleFee,
        oracleAlpha: oracleSettings.alpha,
        oracleEstimatedBaseCost: oracleSettings.estimatedBaseCost,
        oracleMaxFeeBasedScaling: oracleSettings.maxFeeBasedScaling,
      });

      if (!apiResponse?.success) {
        throw new Error(apiResponse?.error || 'Backend job create failed');
      }

      const { job } = apiResponse;
      console.log('✅ Backend job created:', { jobId: job.jobId, rubricCid: job.rubricCid });

      // 2) On-chain create
      setLoadingText('Waiting for wallet / creating on-chain…');
      const contractService = getContractService();
      if (!contractService.isConnected()) await contractService.connect();

      const contractResult = await contractService.createBounty({
        evaluationCid: job.evaluationCid,
        classId: selectedClassId,
        threshold,
        bountyAmountEth,
        submissionWindowHours,
        ...(formData.targetHunter ? { targetHunter: formData.targetHunter } : {}),
        ...(formData.enableApprovalWindow ? {
          creatorDeterminationPaymentEth: parseFloat(formData.creatorPaymentEth),
          arbiterDeterminationPaymentEth: parseFloat(formData.arbiterPaymentEth),
          creatorAssessmentWindowHours: parseFloat(formData.approvalWindowHours),
        } : {}),
        // Prefer the settings the server persisted (already wei-normalised) so the
        // on-chain struct matches the API record exactly; fall back to the form values.
        oracle: job.oracleSettings && job.oracleSettings.maxOracleFee != null ? job.oracleSettings : oracleSettings,
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

      navigate(`/bounty/${contractResult.bountyId}`);
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
        <h1>
          {reissueFrom != null
            ? <><RefreshCw size={28} className="inline-icon" /> Re-issue Bounty</>
            : <><PlusCircle size={28} className="inline-icon" /> Create New Bounty</>}
        </h1>
        <p>Define evaluation criteria and lock ETH in escrow</p>
      </div>

      {reissueFrom != null && (
        <div
          className="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            background: '#eef6ff',
            border: '1px solid #b6d8ff',
            color: '#1c4e80',
          }}
        >
          <RefreshCw size={16} className="inline-icon" />
          <span>
            Re-issuing <strong>bounty #{reissueFrom}</strong> — all settings were copied over with a
            fresh submission window. Review the details below and launch a new bounty. The original
            bounty is unchanged.
          </span>
        </div>
      )}

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

            <section className="work-order-import" aria-labelledby="work-order-import-title">
              <h3 id="work-order-import-title"><Upload size={16} className="inline-icon" /> Import a work-order draft (optional)</h3>
              {!imported && (
                <>
                  <p>
                    Have a draft from an agent or the <a href="/agents#buyer-preview">buyer preview</a>? Import the downloaded <code>.json</code>, or paste the
                    assessment input an agent returned, to prefill the request, rubric, threshold and supplier choice. It is checked in your browser with the
                    same code the onboarding skill uses, and an assessment input is turned into its draft there too.
                    Nothing is sent or submitted: you still review every field, choose the jury and sign with your own wallet.
                  </p>
                  <p>
                    An agent returns its assessment input as JSON in a code block. If its reply came in several messages (part 1/N, part 2/N, …),
                    paste all of them here in order, fences and labels included: only the contents of the JSON code blocks are used.
                  </p>
                  {importHandoff && (
                    <p>Carried over from the buyer preview. Check it with “Import pasted JSON”; nothing has been sent.</p>
                  )}
                  <label className="work-order-file">Draft file
                    <input type="file" accept=".json,application/json" onChange={handleDraftFile} aria-label="Work-order draft file" />
                  </label>
                  <label>Or paste the draft or assessment input JSON
                    <textarea rows={8} value={importPaste} onChange={(e) => setImportPaste(e.target.value)} spellCheck={false} aria-label="Work-order draft JSON" />
                  </label>
                  <button type="button" className="btn btn-secondary" onClick={handleDraftPaste} disabled={!importPaste.trim()}>Import pasted JSON</button>
                </>
              )}
              {importErrors.length > 0 && (
                <div role="alert" className="alert alert-error">
                  <p>The draft was not imported:</p>
                  <ul>{importErrors.map((m, i) => <li key={i}>{m}</li>)}</ul>
                </div>
              )}
              {imported && (
                <div className="work-order-summary" aria-live="polite">
                  <p>
                    <strong>Imported draft</strong>: {imported.summary.template_label}, {imported.summary.items} {imported.summary.item_noun}, task <code>{imported.summary.task_id}</code>.{' '}
                    {imported.draft.procurement.mode === 'TARGETED' ? <>Targeted at <code>{imported.draft.procurement.targetHunter}</code>.</> : 'Open to all submitters.'}
                  </p>
                  <p>Draft SHA-256: <code data-testid="draft-sha256">{imported.sha256}</code></p>
                  {imported.derived && (
                    <p>
                      <button type="button" className="btn btn-text" onClick={downloadDerivedDraft}>Download the derived draft</button>{' '}
                      to give the onboarding skill exactly these bytes.
                    </p>
                  )}
                  <p>
                    The rubric, threshold and supplier are bound to this draft. The evaluation description will end with the committed work-order block
                    (the exact request and its hashes); write your own words above it. The draft is not a quote: set the payout yourself.
                  </p>
                  {importedBlockError
                    ? <p role="alert">{importedBlockError}</p>
                    : <details><summary>Show the block that will be appended to the description</summary><pre className="work-order-block">{importedBlock.trim()}</pre></details>}
                  {imported.extras.local_summary && (
                    <details open>
                      <summary>Found locally by the agent (not independent verification, not part of the commissioned request)</summary>
                      <p>{imported.extras.local_summary.mode === 'RESIDUAL'
                        ? `${imported.extras.local_summary.resolved.length} of ${imported.extras.local_summary.original_item_count} items were resolved by the agent; only the other ${imported.extras.local_summary.residual.length} are in this draft.`
                        : 'The agent made its own non-independent pass; every item is in this draft.'}</p>
                      <ul>
                        {imported.extras.local_summary.resolved.map((r) => <li key={`r-${r.item_id}`}>{r.item_id}: {r.verdict}{r.value != null ? ` = ${String(r.value)}` : ''}. {r.basis}</li>)}
                        {imported.extras.local_summary.residual.map((r) => <li key={`u-${r.item_id}`}>{r.item_id}: left for outside work ({r.reason}){r.note ? `. ${r.note}` : ''}</li>)}
                      </ul>
                    </details>
                  )}
                  {imported.extras.market_context && (
                    <p>
                      Market context (not a quote), {imported.extras.market_context.network}, {imported.extras.market_context.window_days ? `${imported.extras.market_context.window_days}-day window` : 'current listing'},
                      {' '}{imported.extras.market_context.sample_size} bounties:{' '}
                      {imported.extras.market_context.summary.median_bounty_amount_wei != null && `median ${ethers.formatEther(imported.extras.market_context.summary.median_bounty_amount_wei)} ETH; `}
                      {imported.extras.market_context.summary.open != null && `${imported.extras.market_context.summary.open} open; `}
                      {imported.extras.market_context.summary.median_time_to_award_seconds != null && `median time to award ${(imported.extras.market_context.summary.median_time_to_award_seconds / 3600).toFixed(1)} h. `}
                      {imported.extras.market_context.caveat}
                    </p>
                  )}
                  {imported.notes.map((n, i) => <p key={i}>{n}</p>)}
                  {networkWarning && <p role="alert">This draft selected {imported.summary.network}, but this site is on {config.network}. Check the network before you continue.</p>}
                  {divergence.length > 0 && (
                    <div role="alert" className="alert alert-error">
                      <p>The {divergence.join(', ')} no longer match the imported draft, so you cannot create the bounty yet.</p>
                      <button type="button" className="btn btn-secondary" onClick={restoreDraftValues}>Restore draft values</button>
                    </div>
                  )}
                  <button type="button" className="btn btn-text" onClick={removeImport}>Remove imported draft</button>
                </div>
              )}
            </section>

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
              {!formData.enableApprovalWindow && (
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
              )}

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

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="targetHunter">
                  Target Address (optional)
                </label>
                <input
                  type="text"
                  id="targetHunter"
                  value={formData.targetHunter}
                  onChange={(e) => setFormData((prev) => ({ ...prev, targetHunter: e.target.value.trim() }))}
                  placeholder="0x... (leave empty for open bounty)"
                  readOnly={Boolean(imported)}
                />
                <small className="helper-text">
                  {formData.targetHunter
                    ? 'Targeted: only this address can submit'
                    : 'Open to all: anyone can submit'}
                  {imported ? ' (set by the imported draft; remove the import to change it)' : ''}
                </small>
              </div>
            </div>

            {/* Creator Approval Window — opt-in feature card with embedded toggle */}
            <div className={`feature-card ${formData.enableApprovalWindow ? 'enabled' : ''}`}>
              <label className="feature-card-header">
                <Clock size={20} className="feature-card-icon" />
                <div className="feature-card-text">
                  <div className="feature-card-title">Creator Approval Window</div>
                  <div className="feature-card-desc">
                    Approve submissions directly before AI evaluation runs. You can offer a different payment for direct approval vs. oracle approval.
                  </div>
                </div>
                <span className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={formData.enableApprovalWindow}
                    onChange={(e) => setFormData((prev) => ({ ...prev, enableApprovalWindow: e.target.checked }))}
                    aria-label="Enable creator approval window"
                  />
                  <span className="toggle-switch-slider" />
                </span>
              </label>

              {formData.enableApprovalWindow && (
                <div className="feature-card-body">
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="creatorPaymentEth">
                        Creator Approval Payment (ETH) <span className="required">*</span>
                      </label>
                      <input
                        type="number"
                        id="creatorPaymentEth"
                        value={formData.creatorPaymentEth}
                        onChange={(e) => setFormData((prev) => ({ ...prev, creatorPaymentEth: e.target.value }))}
                        placeholder="0.001"
                        step="0.001"
                        min="0"
                      />
                      <small className="helper-text">
                        Amount paid to hunter if you approve directly
                        {formData.creatorPaymentEth && formData.ethPriceUSD > 0 && (
                          <> (≈ ${(parseFloat(formData.creatorPaymentEth) * formData.ethPriceUSD).toFixed(2)} USD)</>
                        )}
                      </small>
                    </div>

                    <div className="form-group">
                      <label htmlFor="arbiterPaymentEth">
                        Arbiter Approval Payment (ETH) <span className="required">*</span>
                      </label>
                      <input
                        type="number"
                        id="arbiterPaymentEth"
                        value={formData.arbiterPaymentEth}
                        onChange={(e) => setFormData((prev) => ({ ...prev, arbiterPaymentEth: e.target.value }))}
                        placeholder="0.001"
                        step="0.001"
                        min="0"
                      />
                      <small className="helper-text">
                        Amount paid to hunter if approved by AI arbiters (after window expires)
                        {formData.arbiterPaymentEth && formData.ethPriceUSD > 0 && (
                          <> (≈ ${(parseFloat(formData.arbiterPaymentEth) * formData.ethPriceUSD).toFixed(2)} USD)</>
                        )}
                      </small>
                    </div>
                  </div>

                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="approvalWindowHours">
                        Approval Window (hours) <span className="required">*</span>
                      </label>
                      <input
                        type="number"
                        id="approvalWindowHours"
                        value={formData.approvalWindowHours}
                        onChange={(e) => setFormData((prev) => ({ ...prev, approvalWindowHours: e.target.value }))}
                        placeholder="0.5"
                        step="0.5"
                        min="0.5"
                      />
                      <small className="helper-text">
                        Time you have to review and approve each submission before it goes to oracle evaluation
                      </small>
                    </div>
                  </div>

                  <div className="escrow-preview">
                    {effectiveBountyAmountEth(formData) != null ? (
                      <>
                        Bounty amount: {effectiveBountyAmountEth(formData)} ETH
                        {formData.ethPriceUSD > 0 && (
                          <> (≈ ${(parseFloat(effectiveBountyAmountEth(formData)) * formData.ethPriceUSD).toFixed(2)} USD)</>
                        )}
                        {' '}— the larger of the two payments above. This is what your wallet escrows and what the bounty lists as its amount.
                      </>
                    ) : (
                      <>Enter both payments above; the bounty amount is the larger of the two.</>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Public Submissions — off-chain visibility flag */}
            <div className={`feature-card ${formData.publicSubmissions ? 'enabled' : ''}`}>
              <label className="feature-card-header">
                <Eye size={20} className="feature-card-icon" />
                <div className="feature-card-text">
                  <div className="feature-card-title">Allow public access to submissions</div>
                  <div className="feature-card-desc">
                    Lets anyone preview and download submitted work on the website, not just you.
                    Submission CIDs are technically public regardless (stored on-chain and returned by
                    the API); this toggle only controls whether the website shows convenient buttons.
                    You can change this later from the bounty page.
                  </div>
                </div>
                <span className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={formData.publicSubmissions}
                    onChange={(e) => setFormData((prev) => ({ ...prev, publicSubmissions: e.target.checked }))}
                    aria-label="Allow public access to submissions"
                  />
                  <span className="toggle-switch-slider" />
                </span>
              </label>
            </div>

            {/* Oracle settings (advanced) — creator-chosen, collapsed by default */}
            <div className={`feature-card ${showOracleSettings ? 'enabled' : ''}`}>
              <div
                className="feature-card-header"
                role="button"
                tabIndex={0}
                onClick={() => setShowOracleSettings((v) => !v)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowOracleSettings((v) => !v); } }}
                aria-expanded={showOracleSettings}
                style={{ cursor: 'pointer' }}
              >
                <Settings size={20} className="feature-card-icon" />
                <div className="feature-card-text">
                  <div className="feature-card-title">Oracle settings (advanced)</div>
                  <div className="feature-card-desc">
                    How arbiters are selected and paid for every evaluation of this bounty. These are fixed
                    at creation and apply to all submissions — hunters cannot change them. The defaults work
                    for most bounties.
                  </div>
                </div>
                {showOracleSettings ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
              </div>

              {showOracleSettings && (
                <div className="feature-card-body">
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="oracleMaxOracleFeeEth">Max oracle fee (ETH per arbiter call)</label>
                      <input
                        type="text"
                        inputMode="decimal"
                        id="oracleMaxOracleFeeEth"
                        value={formData.oracleMaxOracleFeeEth}
                        onChange={(e) => setFormData((prev) => ({ ...prev, oracleMaxOracleFeeEth: e.target.value }))}
                        placeholder={ORACLE_DEFAULTS.oracleMaxOracleFeeEth}
                      />
                      <small className="helper-text">
                        Arbiters priced above this are ineligible. Sizes the hunter's ETH prepay. Must be &gt; 0 and
                        at most {ORACLE_FEE_CEILING_ETH} ETH.
                      </small>
                    </div>
                    <div className="form-group">
                      <label htmlFor="oracleAlpha">Alpha (0–{ORACLE_MAX_ALPHA})</label>
                      <input
                        type="number"
                        id="oracleAlpha"
                        value={formData.oracleAlpha}
                        onChange={(e) => setFormData((prev) => ({ ...prev, oracleAlpha: e.target.value }))}
                        placeholder={ORACLE_DEFAULTS.oracleAlpha}
                        step="1"
                        min="0"
                        max={ORACLE_MAX_ALPHA}
                      />
                      <small className="helper-text">
                        Quality-vs-timeliness blend in arbiter selection: 0 = pure quality, {ORACLE_MAX_ALPHA} = pure timeliness,
                        500 = equal.
                      </small>
                    </div>
                  </div>

                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="oracleEstimatedBaseCostEth">Estimated base cost (ETH)</label>
                      <input
                        type="text"
                        inputMode="decimal"
                        id="oracleEstimatedBaseCostEth"
                        value={formData.oracleEstimatedBaseCostEth}
                        onChange={(e) => setFormData((prev) => ({ ...prev, oracleEstimatedBaseCostEth: e.target.value }))}
                        placeholder={ORACLE_DEFAULTS.oracleEstimatedBaseCostEth}
                      />
                      <small className="helper-text">
                        Baseline for the price boost that favours cheaper arbiters. Must be below the max oracle fee;
                        0 disables the boost.
                      </small>
                    </div>
                    <div className="form-group">
                      <label htmlFor="oracleMaxFeeBasedScaling">Max fee-based scaling (1–{ORACLE_MAX_FEE_SCALING})</label>
                      <input
                        type="number"
                        id="oracleMaxFeeBasedScaling"
                        value={formData.oracleMaxFeeBasedScaling}
                        onChange={(e) => setFormData((prev) => ({ ...prev, oracleMaxFeeBasedScaling: e.target.value }))}
                        placeholder={ORACLE_DEFAULTS.oracleMaxFeeBasedScaling}
                        step="1"
                        min="1"
                        max={ORACLE_MAX_FEE_SCALING}
                      />
                      <small className="helper-text">
                        Caps the price-boost multiplier (x-factor). 1 disables the boost.
                      </small>
                    </div>
                  </div>

                  {(() => {
                    const err = validateOracleSettings(formData);
                    return err
                      ? <div className="escrow-preview" style={{ color: '#b00020' }}><AlertTriangle size={14} className="inline-icon" /> {err}</div>
                      : (
                        <div className="escrow-preview">
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => setFormData((prev) => ({ ...prev, ...ORACLE_DEFAULTS }))}
                          >
                            Reset to defaults
                          </button>
                        </div>
                      );
                  })()}
                </div>
              )}
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
              <label htmlFor="rubricDescription">Rubric Description (Optional)</label>
              <textarea
                id="rubricDescription"
                value={rubric.description}
                onChange={(e) => setRubric((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="Describe what this rubric evaluates..."
                rows={3}
              />
              <small className="helper-text">Rubric Title and Rubric Description are only used as labels for human readers. Neither affects grading.</small>
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
                A class is the set of arbiters that will judge your bounty, and what they can run.
                Pick a class from the registry below, or enter any class ID that arbiters serve:
                anyone can run arbiters for a new class and define what it means.
              </small>
              <ClassSelector selectedClassId={selectedClassId} onClassSelect={handleClassSelect} />
              <ClassCoverage
                classId={selectedClassId}
                maxOracleFee={String(formData.oracleMaxOracleFeeEth || '').trim() || undefined}
                onResult={({ servable }) => setClassServable(servable)}
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
                  disabled={isLoadingModels || (!isCustomClass && Object.keys(availableModels).length === 0)}
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

              {isCustomClass && (
                <datalist id="custom-class-providers">
                  {Object.keys(availableModels).map((provider) => (
                    <option key={provider} value={provider} />
                  ))}
                </datalist>
              )}
              {juryNodes.map((node) => (
                <div key={node.id} className="jury-node">
                  <div className="form-row">
                    {isCustomClass ? (
                      <>
                        {/* Free text for a class outside the registry; earlier
                            classes' models are offered only as suggestions. */}
                        <div className="form-group">
                          <label htmlFor={`jury-provider-${node.id}`}>Provider</label>
                          <input
                            id={`jury-provider-${node.id}`}
                            type="text"
                            value={node.provider}
                            onChange={(e) => updateJuryNode(node.id, 'provider', e.target.value)}
                            list="custom-class-providers"
                            placeholder="As the class's operators advertise"
                            title="Provider identifier served by this class's arbiters"
                            required
                          />
                        </div>

                        <div className="form-group">
                          <label htmlFor={`jury-model-${node.id}`}>Model or tool</label>
                          <input
                            id={`jury-model-${node.id}`}
                            type="text"
                            value={node.model}
                            onChange={(e) => updateJuryNode(node.id, 'model', e.target.value)}
                            list={`custom-class-models-${node.id}`}
                            placeholder="Exact identifier"
                            title="Model or tool identifier served by this class's arbiters"
                            required
                          />
                          <datalist id={`custom-class-models-${node.id}`}>
                            {availableModels[node.provider]?.map((model) => (
                              <option key={model} value={model} />
                            ))}
                          </datalist>
                        </div>
                      </>
                    ) : (
                      <>
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
                      </>
                    )}

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

            <p className="commitment-note">
              Creating this bounty locks your ETH and its terms on-chain: the contract has no function
              to cancel or edit it. That commitment is what lets hunters invest work in your bounty.
              If nobody wins, the funds return to you after the deadline.
            </p>

            <div className="form-actions">
              <button type="button" onClick={() => setStep(2)} className="btn btn-secondary">
                ← Back
              </button>

              <button
                type="submit"
                className="btn btn-primary btn-lg btn-with-icon"
                disabled={loading || juryNodes.length === 0 || divergence.length > 0 || classServable === false}
                title={classServable === false ? 'No arbiters can serve the selected class (see above)' : undefined}
              >
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
          <li>Oracle settings (advanced, defaulted): the per-arbiter fee ceiling, selection blend and price-boost parameters are yours and are used for every evaluation of this bounty. Hunters can see them before submitting; keep the fee at or above the class's going rate so enough arbiters are eligible. If the oracle network later lowers its fee ceiling below your fee, evaluations still run — the contract clamps your fee (and, if needed, base cost) to the ceiling at start.</li>
          <li>Smart contract locks your ETH in escrow.</li>
          <li>Bounty status becomes OPEN - hunters can submit work before deadline. Hunters must also <em>start</em> oracle evaluation before the deadline; finalizing may happen later.</li>
          <li><strong>If approval window enabled:</strong> Each submission enters a creator review period. You can approve directly (paying the creator approval amount) or let the window expire for oracle evaluation. The window must end before the deadline, so hunters can only submit up to one window-length before it.</li>
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
          <p style={{ marginBottom: '0.5rem' }}>
            <strong>First Winner Takes All:</strong> The earliest-submitted submission whose evaluation passes the threshold wins (a later passing one waits for earlier in-flight ones to resolve). Plan your deadline and threshold accordingly.
          </p>
          <p style={{ marginBottom: 0 }}>
            <strong>Approval Window:</strong> If enabled, submissions enter a "Pending Creator Approval" state. You can approve directly (faster, potentially lower cost) or let the window expire for standard AI oracle evaluation. The window runs per submission and must end before the deadline, so keep it short relative to the submission window — hunters cannot submit during the last window-length before the deadline. Earlier submissions from <em>other</em> hunters take priority only while under evaluation or still in their own window. A hunter's own earlier version sitting in its window never blocks, so you can approve a revised version straight away; if their earlier version is already under oracle evaluation you must wait for it to resolve before approving the revision.
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

