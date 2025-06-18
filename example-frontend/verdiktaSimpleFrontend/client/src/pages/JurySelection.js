// src/pages/JurySelection.js
import React, { useState } from 'react';
import { PAGES } from '../App';

function JurySelection({
  outcomeLabels,
  juryNodes,
  setJuryNodes,
  iterations,
  setIterations,
  setCurrentPage,
  setSelectedMethod
}) {
  const [activeTooltipId, setActiveTooltipId] = useState(null);

  // Example provider-model mapping
  const providerModels = {
    OpenAI: ['gpt-3.5-turbo', 'gpt-4', 'gpt-4o'],
    Anthropic: ['claude-2.1', 'claude-3-sonnet-20240229', 'claude-3-5-sonnet-20241022'],
    'Open-source': ['llava', 'llama-3.1', 'llama-3.2', 'phi3']
  };

  const addJuryNode = () => {
    setJuryNodes((prev) => [
      ...prev,
      {
        provider: 'OpenAI',
        model: 'gpt-4o',
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
          if (field === 'provider') {
            updatedNode.model = providerModels[value][0];
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

      <div className="configuration-summary">
        <p>Query will have {outcomeLabels?.length || 0} possible outcomes:</p>
        <ul className="outcomes-list">
          {outcomeLabels?.map((label, index) => (
            <li key={index}>{label}</li>
          ))}
        </ul>
      </div>

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
              >
                {Object.keys(providerModels).map((provider) => (
                  <option key={provider} value={provider}>
                    {provider}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <select
                value={node.model}
                onChange={(e) => updateJuryNode(node.id, 'model', e.target.value)}
              >
                {providerModels[node.provider].map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
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

        <button className="add-node" onClick={addJuryNode}>
          Add Another AI Model
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