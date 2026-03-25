/**
 * Evaluation Details Page
 * Shows the full evaluation package that oracles receive when judging a submission.
 * Gives bidders complete transparency into how their work will be evaluated.
 */

import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Loader2,
  AlertTriangle,
  FileText,
  ExternalLink,
  Shield,
  Scale,
  Users,
  ChevronDown,
  ChevronUp,
  Target,
  Ban,
} from 'lucide-react';
import { apiService } from '../services/api';
import { config } from '../config';
import './EvaluationDetails.css';

const IPFS_GATEWAY = config.ipfsGateway || 'https://ipfs.io';

function EvaluationDetails() {
  const { bountyId } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [queryExpanded, setQueryExpanded] = useState(false);
  const [manifestExpanded, setManifestExpanded] = useState(false);

  useEffect(() => {
    async function fetchPackage() {
      setLoading(true);
      setError(null);
      try {
        const result = await apiService.getEvaluationPackage(bountyId);
        setData(result);
      } catch (err) {
        setError(err.response?.data?.error || err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchPackage();
  }, [bountyId]);

  if (loading) {
    return (
      <div className="evaluation-details">
        <div className="loading">
          <Loader2 size={32} className="spinning" />
          <p>Fetching evaluation package from IPFS...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="evaluation-details">
        <Link to={`/bounty/${bountyId}`} className="back-link">
          <ArrowLeft size={16} /> Back to Bounty
        </Link>
        <div className="error-card">
          <AlertTriangle size={24} />
          <h2>Could not load evaluation details</h2>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { manifest, primaryQuery, rubric, rubricCid, juryConfig, threshold, classId, evaluationCid, meta } = data;

  // Extract criteria from rubric
  const criteria = rubric?.criteria || [];
  const mustPass = criteria.filter(c => c.must === true);
  const weighted = criteria.filter(c => !c.must);
  const forbiddenContent = rubric?.forbiddenContent || rubric?.forbidden_content || [];

  return (
    <div className="evaluation-details">
      <Link to={`/bounty/${bountyId}`} className="back-link">
        <ArrowLeft size={16} /> Back to Bounty
      </Link>

      {/* Header */}
      <div className="eval-header">
        <h1><Scale size={28} /> Evaluation Details</h1>
        <p className="eval-subtitle">
          Bounty #{meta?.jobId ?? bountyId}{meta?.title ? ` — ${meta.title}` : ''}
        </p>
        <p className="eval-description">
          This page shows exactly what the AI oracle arbiters receive when evaluating a submission.
          All scoring rules, criteria, and instructions shown here are used verbatim by the oracles.
        </p>
      </div>

      {/* Evaluation Protocol Overview */}
      <section className="eval-card">
        <h2><Shield size={20} /> Evaluation Protocol Overview</h2>
        <div className="protocol-overview">
          <div className="protocol-item">
            <strong>Outcomes:</strong>
            <span className="outcome-badges">
              <span className="outcome-badge outcome-fund">FUND</span>
              <span className="outcome-badge outcome-dont-fund">DONT_FUND</span>
            </span>
          </div>
          {threshold != null && (
            <div className="protocol-item">
              <strong>Acceptance Threshold:</strong>
              <span>{threshold}% — a submission needs at least {threshold}% FUND score to be accepted</span>
            </div>
          )}
          {classId != null && (
            <div className="protocol-item">
              <strong>Verdikta Class ID:</strong>
              <span className="mono-value">{classId}</span>
            </div>
          )}
          <div className="protocol-item">
            <strong>Work Product Type:</strong>
            <span>{meta?.workProductType || 'Work Product'}</span>
          </div>

          {mustPass.length > 0 && weighted.length > 0 && (
            <div className="protocol-phases">
              <div className="phase-card phase-mandatory">
                <div className="phase-label">Phase 1</div>
                <div className="phase-title">Mandatory Requirements</div>
                <div className="phase-desc">
                  Hard pass/fail gates. If ANY mandatory criterion fails, the submission is immediately
                  scored <strong>DONT_FUND = 100, FUND = 0</strong>. Phase 2 is skipped entirely.
                </div>
              </div>
              <div className="phase-arrow">then</div>
              <div className="phase-card phase-weighted">
                <div className="phase-label">Phase 2</div>
                <div className="phase-title">Weighted Quality Scoring</div>
                <div className="phase-desc">
                  Only reached if all Phase 1 criteria pass. Each criterion is scored 0-100,
                  then a weighted average determines the final FUND/DONT_FUND split.
                </div>
              </div>
            </div>
          )}
          {mustPass.length > 0 && weighted.length === 0 && (
            <div className="protocol-note">
              All criteria are mandatory pass/fail. If all pass: FUND = 100. If any fail: DONT_FUND = 100.
            </div>
          )}
          {mustPass.length === 0 && weighted.length > 0 && (
            <div className="protocol-note">
              All criteria are weighted quality scores. The weighted average determines the FUND/DONT_FUND split.
            </div>
          )}
        </div>
      </section>

      {/* Phase 1: Mandatory Requirements */}
      {mustPass.length > 0 && (
        <section className="eval-card">
          <h2><Target size={20} /> Phase 1: Mandatory Requirements</h2>
          <p className="section-note">
            Each criterion below is evaluated as PASS or FAIL. A single failure results in
            immediate rejection (DONT_FUND = 100).
          </p>
          <div className="criteria-list">
            {mustPass.map((c, i) => (
              <div key={i} className="criterion-item criterion-must-pass">
                <div className="criterion-header">
                  <span className="criterion-badge badge-must-pass">MUST PASS</span>
                  <span className="criterion-label">{c.label || c.id}</span>
                </div>
                <p className="criterion-desc">{c.instructions || c.description || ''}</p>
              </div>
            ))}
          </div>
          {forbiddenContent.length > 0 && (
            <div className="forbidden-section">
              <h3><Ban size={16} /> Forbidden Content</h3>
              <p className="section-note">
                The following items are explicitly forbidden. Presence of any results in immediate failure.
              </p>
              <ul className="forbidden-list">
                {forbiddenContent.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* Phase 2: Weighted Criteria */}
      {weighted.length > 0 && (
        <section className="eval-card">
          <h2><Scale size={20} /> {mustPass.length > 0 ? 'Phase 2: ' : ''}Weighted Quality Criteria</h2>
          <p className="section-note">
            Each criterion is scored 0-100. The final score is a weighted average.
            {mustPass.length > 0 && ' This phase is only reached if all mandatory requirements pass.'}
          </p>
          <div className="criteria-list">
            {weighted.map((c, i) => (
              <div key={i} className="criterion-item criterion-weighted">
                <div className="criterion-header">
                  <span className="criterion-badge badge-weighted">
                    Weight: {((c.weight || 0) * 100).toFixed(0)}%
                  </span>
                  <span className="criterion-label">{c.label || c.id}</span>
                </div>
                <p className="criterion-desc">{c.instructions || c.description || ''}</p>
              </div>
            ))}
          </div>
          <div className="scoring-formula">
            <strong>Scoring formula:</strong> Weighted average of all criteria scores above, where
            higher averages yield higher FUND scores and lower DONT_FUND scores.
          </div>
        </section>
      )}

      {/* Jury Configuration */}
      {juryConfig && (
        <section className="eval-card">
          <h2><Users size={20} /> Jury Configuration</h2>
          <p className="section-note">
            These are the exact AI model specifications from the evaluation package.
            Each model evaluates independently; results are combined by weight.
          </p>
          <div className="jury-details-grid">
            {juryConfig.nodes.map((node, i) => (
              <div key={i} className="jury-detail-card">
                <div className="jury-detail-provider">{node.provider}</div>
                <div className="jury-detail-model">{node.model}</div>
                <div className="jury-detail-stats">
                  <span>Weight: <strong>{node.weight}</strong></span>
                  <span>Runs: <strong>{node.runs}</strong></span>
                </div>
              </div>
            ))}
          </div>
          <div className="jury-meta">
            <span>Iterations: <strong>{juryConfig.iterations}</strong></span>
            <span>Number of outcomes: <strong>{juryConfig.numberOfOutcomes}</strong></span>
          </div>
        </section>
      )}

      {/* Full Evaluation Prompt */}
      {primaryQuery?.query && (
        <section className="eval-card">
          <h2>
            <FileText size={20} /> Full Evaluation Prompt
          </h2>
          <p className="section-note">
            This is the exact text sent to each oracle arbiter. It includes all instructions,
            criteria, scoring rules, and justification format requirements.
          </p>
          <button
            className="expand-toggle"
            onClick={() => setQueryExpanded(!queryExpanded)}
          >
            {queryExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            {queryExpanded ? 'Collapse' : 'Show full prompt'}
          </button>
          {queryExpanded && (
            <pre className="query-text">{primaryQuery.query}</pre>
          )}
        </section>
      )}

      {/* Raw Files */}
      <section className="eval-card">
        <h2><FileText size={20} /> Raw Evaluation Files</h2>
        <p className="section-note">
          Direct links to the JSON files that make up the evaluation package on IPFS.
        </p>

        {/* Inline JSON viewers */}
        {manifest && (
          <div className="raw-file-section">
            <button
              className="expand-toggle"
              onClick={() => setManifestExpanded(!manifestExpanded)}
            >
              {manifestExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              {manifestExpanded ? 'Hide manifest.json' : 'Show manifest.json'}
            </button>
            {manifestExpanded && (
              <pre className="json-viewer">{JSON.stringify(manifest, null, 2)}</pre>
            )}
          </div>
        )}

        {/* IPFS links */}
        <div className="ipfs-links">
          {evaluationCid && (
            <a
              href={`${IPFS_GATEWAY}/ipfs/${evaluationCid}`}
              target="_blank"
              rel="noopener noreferrer"
              className="ipfs-link"
            >
              <FileText size={16} />
              Evaluation Archive (ZIP)
              <ExternalLink size={14} />
            </a>
          )}
          {rubricCid && (
            <a
              href={`${IPFS_GATEWAY}/ipfs/${rubricCid}`}
              target="_blank"
              rel="noopener noreferrer"
              className="ipfs-link"
            >
              <FileText size={16} />
              Grading Rubric (JSON)
              <ExternalLink size={14} />
            </a>
          )}
        </div>
        {evaluationCid && (
          <div className="cid-display">
            <span className="cid-label">Evaluation CID:</span>
            <code className="cid-value">{evaluationCid}</code>
          </div>
        )}
        {rubricCid && (
          <div className="cid-display">
            <span className="cid-label">Rubric CID:</span>
            <code className="cid-value">{rubricCid}</code>
          </div>
        )}
      </section>
    </div>
  );
}

export default EvaluationDetails;
