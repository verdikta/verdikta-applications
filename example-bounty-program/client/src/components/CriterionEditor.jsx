import { useState } from 'react';
import './CriterionEditor.css';

function CriterionEditor({ criterion, onChange, onRemove, canRemove = true, index }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const handleFieldChange = (field, value) => {
    onChange({
      ...criterion,
      [field]: value
    });
  };

  const handleWeightChange = (value) => {
    const weight = Math.max(0, Math.min(1, parseFloat(value) || 0));
    onChange({
      ...criterion,
      weight
    });
  };

  const toggleMust = () => {
    const newMust = !criterion.must;
    onChange({
      ...criterion,
      must: newMust,
      weight: newMust ? 0.0 : 0.20 // Default weight when switching to scored
    });
  };

  return (
    <div className={`criterion-editor ${criterion.must ? 'must-pass' : 'scored'} ${isExpanded ? 'expanded' : ''}`}>
      <div className="criterion-header" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="criterion-header-left">
          <span className="criterion-icon">{criterion.must ? '🔒' : '⭐'}</span>
          <span className="criterion-label">{criterion.label || 'Untitled Criterion'}</span>
          {!criterion.must && (
            <span className="criterion-weight-badge">Weight: {criterion.weight.toFixed(2)}</span>
          )}
        </div>
        <div className="criterion-header-right">
          <button
            type="button"
            className="criterion-expand-btn"
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}
          >
            {isExpanded ? '▼' : '▶'}
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="criterion-body">
          <div className="criterion-form-row">
            <label htmlFor={`label-${criterion.id}`}>Label *</label>
            <input
              id={`label-${criterion.id}`}
              type="text"
              value={criterion.label}
              onChange={(e) => handleFieldChange('label', e.target.value)}
              placeholder="e.g., Technical Accuracy"
              required
            />
          </div>

          <div className="criterion-form-row">
            <label htmlFor={`instructions-${criterion.id}`}>Instructions *</label>
            <textarea
              id={`instructions-${criterion.id}`}
              value={criterion.instructions}
              onChange={(e) => handleFieldChange('instructions', e.target.value)}
              placeholder="Detailed instructions for AI evaluators..."
              rows={3}
              required
            />
          </div>

          <div className="criterion-form-row criterion-type-row">
            <div className="criterion-type-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={criterion.must}
                  onChange={toggleMust}
                />
                <span className="toggle-label">
                  Must-Pass Criterion
                  <small>Pass/Fail only, no weight</small>
                </span>
              </label>
            </div>

            {!criterion.must && (
              <div className="criterion-weight-control">
                <label htmlFor={`weight-${criterion.id}`}>Weight</label>
                <div className="weight-input-group">
                  <input
                    id={`weight-${criterion.id}`}
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={criterion.weight}
                    onChange={(e) => handleWeightChange(e.target.value)}
                  />
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    value={criterion.weight}
                    onChange={(e) => handleWeightChange(e.target.value)}
                    className="weight-number-input"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="criterion-actions">
            <button
              type="button"
              className="btn-remove-criterion"
              onClick={onRemove}
              disabled={!canRemove}
              title={!canRemove ? 'Cannot remove last criterion' : 'Remove this criterion'}
            >
              🗑️ Remove Criterion
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default CriterionEditor;

