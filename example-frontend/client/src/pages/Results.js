// src/pages/Results.js
import React, { useState } from 'react';
import { PAGES } from '../App';
import { Bar } from 'react-chartjs-2';
import PaginatedJustification from '../components/paginatedJustification';
import { fetchWithRetry, tryParseJustification } from '../utils/fetchUtils';

function Results({
  queryText,
  outcomeLabels,
  outcomes,
  justification,
  resultCid,
  setResultCid,
  lookupCid,
  setLookupCid,
  loadingResults,
  resultTimestamp,
  packageDetails,
  currentCid,
  setCurrentPage,
  setJustification,
  setOutcomes,
  setResultTimestamp,
  setOutcomeLabels
}) {
  const handleLoadResults = async (cid) => {
    try {
      console.log('Loading results for CID:', cid);
      const response = await fetchWithRetry(cid);
      const justificationText = await tryParseJustification(
        response,
        cid,
        setOutcomes,
        setResultTimestamp,
        setOutcomeLabels
      );
      setJustification(justificationText);
    } catch (error) {
      console.error('Error loading results:', error);
      setJustification(`Error loading justification: ${error.message}`);
    }
  };

  const renderBarGraph = () => {
    if (!outcomes || outcomes.length === 0) return null;
    const data = {
      labels: outcomes.map((_, i) => outcomeLabels[i] || `Outcome ${i + 1}`),
      datasets: [
        {
          label: 'Likelihood',
          data: outcomes,
          backgroundColor: outcomes.map((_, i) =>
            i === 0 ? 'rgba(94, 55, 244, 0.8)' : 'rgba(61, 35, 94, 0.8)'
          ),
          borderColor: outcomes.map((_, i) =>
            i === 0 ? '#5E37F4' : '#3D235E'
          ),
          borderWidth: 1
        }
      ]
    };

    const options = {
      responsive: true,
      scales: {
        y: {
          beginAtZero: true,
          max: 1000000
        }
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (context) => {
              const value = context.raw;
              const percentage = ((value / 1000000) * 100).toFixed(1);
              return `${value.toLocaleString()} (${percentage}%)`;
            }
          }
        }
      }
    };

    return (
      <div className="results-chart">
        <Bar data={data} options={options} />
      </div>
    );
  };

  return (
    <div className="page results">
      <h2>Results</h2>

      <section className="configuration-summary">
        <h3>Query Configuration</h3>
        <div className="summary-details">
          <div className="query-text">
            <label>Query:</label>
            <div className="query-value">
              {packageDetails ? packageDetails.query : queryText}
            </div>
          </div>
          <div className="config-stats">
            <span>
              Outcomes: {packageDetails ? packageDetails.numOutcomes : outcomeLabels.length}
            </span>
            <span>
              Iterations: {packageDetails ? packageDetails.iterations : '1'}
            </span>
            <span>
              Jury Members: {packageDetails ? packageDetails.juryNodes.length : '1'}
            </span>
            <span>
              Supporting Files:{' '}
              {packageDetails
                ? packageDetails.additionalFiles.length + packageDetails.supportFiles.length
                : supportingFilesCount()}
            </span>
          </div>

          {packageDetails?.juryNodes && (
            <div className="jury-details">
              <h4>AI Jury Configuration</h4>
              <div className="jury-list">
                {packageDetails.juryNodes.map((node, index) => (
                  <div key={index} className="jury-node-summary">
                    <span>
                      {node.AI_PROVIDER} - {node.AI_MODEL}
                    </span>
                    <span>Runs: {node.NO_COUNTS}</span>
                    <span>Weight: {(node.WEIGHT * 100).toFixed(1)}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {resultCid && (
        <section className="results-display">
          <div className="results-header">
            <div className="cid-display">
              <label>Query Package CID:</label>
              <div className="cid-value">
                <a
                  href={`https://ipfs.io/ipfs/${currentCid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {currentCid}
                </a>
                <button
                  className="copy-button"
                  onClick={() => {
                    navigator?.clipboard?.writeText?.(currentCid)
                      ?.then(() => alert('Copied!'))
                      ?.catch(() => alert('Copy failed'));
                  }}
                >
                  📋
                </button>
              </div>
            </div>

            <div className="cid-display">
              <label>Result CID:</label>
              <div className="cid-value">
                <a
                  href={`https://ipfs.io/ipfs/${resultCid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {resultCid}
                </a>
                <button
                  className="copy-button"
                  onClick={() => {
                    navigator?.clipboard?.writeText?.(resultCid)
                      ?.then(() => alert('Copied!'))
                      ?.catch(() => alert('Copy failed'));
                  }}
                >
                  📋
                </button>
              </div>
            </div>

            {resultTimestamp && (
              <div className="timestamp">
                <label>Evaluation Time:</label>
                <div className="timestamp-value">
                  {new Date(resultTimestamp).toLocaleString(undefined, {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    timeZoneName: 'short'
                  })}
                </div>
              </div>
            )}
          </div>

          {renderBarGraph()}

          <div className="justification">
            <h3>AI Jury Justification</h3>
            <div className="justification-content">
              <PaginatedJustification
                resultCid={resultCid}
                initialText={justification}
                onFetchComplete={(text) => {
                  console.log('Justification fetch complete:', text?.substring(0, 100) + '...');
                  setJustification(text);
                }}
                onUpdateOutcomes={(newOutcomes) => {
                  console.log('Updating outcomes:', newOutcomes);
                  setOutcomes(newOutcomes);
                }}
                onUpdateTimestamp={(ts) => {
                  console.log('Updating timestamp:', ts);
                  setResultTimestamp(ts);
                }}
                setOutcomeLabels={setOutcomeLabels}
              />
            </div>
          </div>
        </section>
      )}

      <section className="past-results-section">
        <div className="section-partition"></div>
        <h3>View Past Results</h3>
        <div className="lookup-form">
          <input
            type="text"
            placeholder="Enter Result CID"
            value={lookupCid}
            onChange={(e) => setLookupCid(e.target.value)}
          />
          <button onClick={() => handleLoadResults(lookupCid)} disabled={!lookupCid.trim() || loadingResults}>
            {loadingResults ? 'Loading...' : 'Load Results'}
          </button>
        </div>
      </section>

      <div className="actions">
        <button
          className="primary"
          onClick={() => {
            setResultCid('');
            setOutcomes([]);
            setJustification('');
            setCurrentPage(PAGES.DEFINE_QUERY);
          }}
        >
          New Query
        </button>
      </div>
    </div>
  );

  function supportingFilesCount() {
    // If you want to store that in props, do so
    return 0; 
  }
}

export default Results;