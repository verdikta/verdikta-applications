import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, FileText, AlertTriangle, Cpu } from 'lucide-react';
import { apiService } from '../services/api';
import './JuryModels.css';

/**
 * Displays the AI jury models that will evaluate a bounty's submissions.
 *
 * Source of truth for the models is manifest.juryParameters.AI_NODES inside the
 * evaluation package on IPFS. For bounties created through this server's API the
 * models are mirrored onto job.juryNodes, but for bounties synced from on-chain
 * BountyCreated events that field is empty — so when it is, we lazily fetch the
 * evaluation package (GET /api/jobs/:id/evaluation-package) and read the models
 * out of its juryConfig. This is the same data the /bounty/:id/evaluation page
 * shows, surfaced up-front so hunters know who is judging them.
 *
 * @param {string|number} props.bountyId
 * @param {Array} [props.juryNodes]      job.juryNodes (may be empty)
 * @param {string} [props.evaluationCid] used to decide whether a fetch is possible
 * @param {string} [props.title]
 * @param {string} [props.description]
 * @param {boolean} [props.showEvalLink] render the "View Full Evaluation Details" link
 */
export default function JuryModels({
  bountyId,
  juryNodes,
  evaluationCid,
  title = 'AI Jury Configuration',
  description = 'Submissions are evaluated by the AI models below. Each model scores independently, and the final score is a weighted average.',
  showEvalLink = true,
}) {
  // Normalize the stored juryNodes (camelCase) into a common shape.
  const stored = (Array.isArray(juryNodes) ? juryNodes : [])
    .map((n) => ({
      provider: n.provider,
      model: n.model,
      weight: n.weight,
      runs: n.runs || n.counts || 1,
    }))
    .filter((n) => n.model);

  const hasStored = stored.length > 0;
  const isDevCid = evaluationCid && String(evaluationCid).startsWith('dev-');
  const canFetch = !hasStored && !!evaluationCid && !isDevCid;

  const [fetched, setFetched] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!canFetch) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiService
      .getEvaluationPackage(bountyId)
      .then((res) => {
        if (!cancelled) setFetched(res?.juryConfig?.nodes || []);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err?.response?.data?.error ||
              err?.message ||
              'Failed to load AI jury models'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bountyId, canFetch]);

  const nodes = hasStored ? stored : fetched || [];

  // Nothing stored, nothing fetchable, nothing in flight → render nothing.
  if (!hasStored && !canFetch && !loading) return null;

  const formatWeight = (w) => {
    const n = Number(w);
    if (!Number.isFinite(n)) return null;
    // Weights are stored as fractions (e.g. 0.5); show as a percentage.
    return `${Math.round(n * 100)}%`;
  };

  return (
    <section className="jury-section">
      <h2>
        <Cpu size={20} className="inline-icon" /> {title}
      </h2>
      <p className="jury-description">{description}</p>

      {loading && (
        <p className="jury-status">
          <Loader2 size={14} className="spin" /> Loading AI models from the evaluation package…
        </p>
      )}

      {error && !loading && (
        <p className="jury-status jury-status-error">
          <AlertTriangle size={14} className="inline-icon" /> Could not load AI models: {error}
        </p>
      )}

      {!loading && !error && nodes.length === 0 && (
        <p className="jury-status">AI model information is not available for this bounty.</p>
      )}

      {nodes.length > 0 && (
        <div className="jury-grid">
          {nodes.map((node, index) => {
            const weight = formatWeight(node.weight);
            return (
              <div key={index} className="jury-card">
                <div className="jury-provider">{node.provider}</div>
                <div className="jury-model">{node.model}</div>
                <div className="jury-details">
                  {weight && <span className="jury-weight">Weight: {weight}</span>}
                  {node.runs > 1 && <span className="jury-runs">{node.runs} runs</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showEvalLink && evaluationCid && !isDevCid && (
        <Link to={`/bounty/${bountyId}/evaluation`} className="eval-details-link">
          <FileText size={16} /> View Full Evaluation Details
        </Link>
      )}
    </section>
  );
}
