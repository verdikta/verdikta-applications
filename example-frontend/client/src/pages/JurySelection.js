// src/pages/JurySelection.js
import React, { useState } from 'react';
import { PAGES } from '../App';
import ClassSelector from '../components/ClassSelector';
import { JURY_PRESETS, DEFAULT_JURY_PRESET_KEY, formatJury } from '../utils/juryPresets';

function JurySelection({
  outcomeLabels,
  juryNodes,
  setJuryNodes,
  iterations,
  setIterations,
  setCurrentPage,
  setSelectedMethod,
  // Dynamic model props
  availableModels,
  classInfo,
  isLoadingModels,
  modelError,
  selectedClassId,
  onClassSelect,
  overrideClassInfo,
  staticConfigMode = false,
  // The arbiter jury every request carries (utils/juryPresets.js)
  juryPresetKey = DEFAULT_JURY_PRESET_KEY,
  onJuryPresetChange
}) {
  const [activeTooltipId, setActiveTooltipId] = useState(null);

  // Use dynamic models from the selected class, fallback to empty object
  const providerModels = availableModels || {};

  const addJuryNode = () => {
    // Get first available provider and model
    const availableProviders = Object.keys(providerModels);
    if (availableProviders.length === 0) {
      console.warn('No providers available for selected class');
      return;
    }
    
    const firstProvider = availableProviders[0];
    const firstModel = providerModels[firstProvider]?.[0] || '';
    
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
          if (field === 'provider' && providerModels[value]) {
            updatedNode.model = providerModels[value][0] || '';
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

  return (
    <div className="page jury-selection">
      <h2>Jury Selection</h2>

      {/* Class Selector Component - Hidden in static config mode */}
      {!staticConfigMode && (
        <ClassSelector
          selectedClassId={selectedClassId}
          onClassSelect={onClassSelect}
          isLoading={isLoadingModels}
          error={modelError}
          overrideClassInfo={overrideClassInfo}
        />
      )}
      
      {/* Show static class info in static config mode */}
      {staticConfigMode && (
        <div className="static-config-info">
          <h3>AI Class Configuration (Static Mode)</h3>
          <p>Using Class ID: <strong>{selectedClassId}</strong></p>
          {classInfo && (
            <p>Class Status: <strong>{classInfo.status}</strong></p>
          )}
        </div>
      )}

      <div className="configuration-summary">
        <p>Query will have {outcomeLabels?.length || 0} possible outcomes:</p>
        <ul className="outcomes-list">
          {outcomeLabels?.map((label, index) => (
            <li key={index}>{label}</li>
          ))}
        </ul>
      </div>

      <section className="arbiter-jury-size">
        <div className="form-group">
          <div className="label-with-tooltip">
            <label htmlFor="jury-preset">Arbiter jury size</label>
            <div
              className="tooltip-trigger"
              onMouseEnter={() => setActiveTooltipId('jury-preset')}
              onMouseLeave={() => setActiveTooltipId(null)}
            >
              ⓘ
              {activeTooltipId === 'jury-preset' && (
                <div className="tooltip-content">
                  Sent with every request: K arbiters drawn / M promoted to reveal / N reveals
                  counted / P clustered, and the round timeout from the draw. A larger jury costs
                  more (the prepay is max(fee, floor) × (K + 3 × P) plus the draw and promote
                  rewards). Jumbo also runs a beacon stage before the draw.
                </div>
              )}
            </div>
          </div>
          <select
            id="jury-preset"
            value={juryPresetKey}
            onChange={(e) => onJuryPresetChange?.(e.target.value)}
            disabled={!onJuryPresetChange}
          >
            {JURY_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}: {formatJury(p.jury)}{p.withBeacons ? ', with beacons' : ''}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="jury-table">
        <h3>AI Jury Configuration</h3>
        
        <div className="iterations-section">
          <div className="form-group">
            <div className="label-with-tooltip">
              <label htmlFor="iterations">Number of Iterations</label>
              <div
                className="tooltip-trigger"
                onMouseEnter={() => setActiveTooltipId('iterations')}
                onMouseLeave={() => setActiveTooltipId(null)}
              >
                ⓘ
                {activeTooltipId === 'iterations' && (
                  <div className="tooltip-content">
                    The jury process can be repeated multiple times...
                  </div>
                )}
              </div>
            </div>
            <div className="numeric-input">
              <button onClick={() => setIterations(prev => Math.max(1, prev - 1))}>-</button>
              <input
                type="number"
                id="iterations"
                value={iterations}
                onChange={(e) => setIterations(Math.max(1, parseInt(e.target.value) || 1))}
                min="1"
              />
              <button onClick={() => setIterations(prev => prev + 1)}>+</button>
            </div>
          </div>
        </div>

        <div className="jury-table-header">
          <div className="label-with-tooltip">
            Provider
            <div
              className="tooltip-trigger"
              onMouseEnter={() => setActiveTooltipId('provider')}
              onMouseLeave={() => setActiveTooltipId(null)}
            >
              ⓘ
              {activeTooltipId === 'provider' && (
                <div className="tooltip-content">
                  The AI service provider that processes part of the query...
                </div>
              )}
            </div>
          </div>
          <div className="label-with-tooltip">
            Model
            <div
              className="tooltip-trigger"
              onMouseEnter={() => setActiveTooltipId('model')}
              onMouseLeave={() => setActiveTooltipId(null)}
            >
              ⓘ
              {activeTooltipId === 'model' && (
                <div className="tooltip-content">
                  The specific AI model to use...
                </div>
              )}
            </div>
          </div>
          <div className="label-with-tooltip">
            Runs
            <div
              className="tooltip-trigger"
              onMouseEnter={() => setActiveTooltipId('runs')}
              onMouseLeave={() => setActiveTooltipId(null)}
            >
              ⓘ
              {activeTooltipId === 'runs' && (
                <div className="tooltip-content">
                  The number of times this model will process the query...
                </div>
              )}
            </div>
          </div>
          <div className="label-with-tooltip">
            Weight
            <div
              className="tooltip-trigger"
              onMouseEnter={() => setActiveTooltipId('weight')}
              onMouseLeave={() => setActiveTooltipId(null)}
            >
              ⓘ
              {activeTooltipId === 'weight' && (
                <div className="tooltip-content">
                  The relative importance of this model's output (0-1)...
                </div>
              )}
            </div>
          </div>
          <div></div>
        </div>

        {juryNodes.map((node) => (
          <div key={node.id} className="jury-node">
            <div>
              <select
                value={node.provider}
                onChange={(e) => updateJuryNode(node.id, 'provider', e.target.value)}
                disabled={Object.keys(providerModels).length === 0}
              >
                {Object.keys(providerModels).length === 0 ? (
                  <option value="">No providers available</option>
                ) : (
                  Object.keys(providerModels).map((provider) => (
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
                disabled={!providerModels[node.provider] || providerModels[node.provider].length === 0}
              >
                {!providerModels[node.provider] || providerModels[node.provider].length === 0 ? (
                  <option value="">No models available</option>
                ) : (
                  providerModels[node.provider].map((model) => (
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
                className="remove-node"
                onClick={() => removeJuryNode(node.id)}
                disabled={juryNodes.length === 1}
              >
                ×
              </button>
            </div>
          </div>
        ))}

        <button 
          className="add-node" 
          onClick={addJuryNode}
          disabled={Object.keys(providerModels).length === 0}
          title={Object.keys(providerModels).length === 0 ? 'No models available for selected class' : ''}
        >
          {Object.keys(providerModels).length === 0 ? 'No Models Available' : 'Add Another AI Model'}
        </button>
      </section>

      <div className="actions">
        <button className="secondary" onClick={() => setCurrentPage(PAGES.DEFINE_QUERY)}>
          Back
        </button>
        <button
          className="primary"
          onClick={() => {
            setSelectedMethod('config');
            setCurrentPage(PAGES.RUN);
          }}
          disabled={juryNodes.length === 0}
        >
          Next: Run Query
        </button>
      </div>
    </div>
  );
}

export default JurySelection;