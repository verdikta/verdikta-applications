// src/pages/QueryDefinition.js
import React, { useState, useEffect } from 'react';
import { PAGES } from '../App';
import ClassSelector from '../components/ClassSelector';

function QueryDefinition({
  queryText,
  setQueryText,
  outcomeLabels,
  setOutcomeLabels,
  supportingFiles,
  setSupportingFiles,
  ipfsCids,
  setIpfsCids,
  cidInput,
  setCidInput,
  hyperlinks,
  setHyperlinks,
  linkInput,
  setLinkInput,
  setCurrentPage,
  classInfo,
  selectedClassId,
  onClassSelect,
  isLoadingModels,
  modelError,
  overrideClassInfo
}) {
  const [activeTooltipId, setActiveTooltipId] = useState(null);

  // Enforce max outcomes limit when class info changes
  useEffect(() => {
    if (classInfo?.limits?.max_outcomes) {
      const maxOutcomes = classInfo.limits.max_outcomes;
      if (outcomeLabels.length > maxOutcomes) {
        console.warn(`Trimming outcomes to max limit: ${maxOutcomes}`);
        setOutcomeLabels(prev => prev.slice(0, maxOutcomes));
      }
    }
  }, [classInfo?.limits?.max_outcomes, outcomeLabels.length, setOutcomeLabels]);

  return (
    <div className="page query-definition">
      <h2>Enter the Question for the AI Jury</h2>

      {/* Class Selector Component */}
      <ClassSelector
        selectedClassId={selectedClassId}
        onClassSelect={onClassSelect}
        isLoading={isLoadingModels}
        error={modelError}
        overrideClassInfo={overrideClassInfo}
      />

      <section className="query-section">
        <div className="form-group">
          <label htmlFor="queryText">
            Provide the question or scenario you want the AI Jury to deliberate on
          </label>
          <textarea
            id="queryText"
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            placeholder="Enter your query here..."
            rows={5}
          />
        </div>

        <div className="form-group">
          <div className="label-with-tooltip">
            <label>Possible Outcomes</label>
            <div
              className="tooltip-trigger"
              onMouseEnter={() => setActiveTooltipId('outcomes')}
              onMouseLeave={() => setActiveTooltipId(null)}
            >
              ⓘ
              {activeTooltipId === 'outcomes' && (
                <div className="tooltip-content">
                  Define the possible outcomes for your query. Each outcome will
                  correspond to a position in the results vector.
                </div>
              )}
            </div>
          </div>

          <div className="outcomes-list">
            {outcomeLabels.map((label, index) => (
              <div key={index} className="outcome-entry">
                <span className="outcome-index">{index + 1}.</span>
                <input
                  type="text"
                  value={label}
                  onChange={(e) => {
                    const newLabels = [...outcomeLabels];
                    newLabels[index] = e.target.value;
                    setOutcomeLabels(newLabels);
                  }}
                  placeholder={`Outcome ${index + 1}`}
                />
                {outcomeLabels.length > 2 && (
                  <button
                    className="remove-outcome"
                    onClick={() =>
                      setOutcomeLabels((labels) =>
                        labels.filter((_, i) => i !== index)
                      )
                    }
                    title="Remove outcome"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button
              className="add-outcome"
              onClick={() => {
                const maxOutcomes = classInfo?.limits?.max_outcomes || 20;
                if (outcomeLabels.length < maxOutcomes) {
                  setOutcomeLabels((labels) => [
                    ...labels,
                    `Outcome ${labels.length + 1}`
                  ]);
                }
              }}
              disabled={outcomeLabels.length >= (classInfo?.limits?.max_outcomes || 20)}
              title={
                outcomeLabels.length >= (classInfo?.limits?.max_outcomes || 20) 
                  ? `Maximum outcomes reached: ${classInfo?.limits?.max_outcomes || 20}` 
                  : ''
              }
            >
              {outcomeLabels.length >= (classInfo?.limits?.max_outcomes || 20)
                ? `Max Outcomes Reached (${classInfo?.limits?.max_outcomes || 20})`
                : '+ Add Outcome'
              }
            </button>
          </div>
        </div>
      </section>

      <div className="section-partition"></div>

      <section className="supporting-data-section">
        <h3>Supporting Data</h3>

        <div className="form-group">
          <div className="label-with-tooltip">
            <label>Upload Files</label>
            <div
              className="tooltip-trigger"
              onMouseEnter={() => setActiveTooltipId('files')}
              onMouseLeave={() => setActiveTooltipId(null)}
            >
              ⓘ
              {activeTooltipId === 'files' && (
                <div className="tooltip-content">
                  Upload any relevant documents, images, or data files that will
                  help the AI Jury make an informed decision.
                </div>
              )}
            </div>
          </div>
          <input
            type="file"
            multiple
            onChange={(e) => {
              const files = Array.from(e.target.files || []).map((file) => ({
                file,
                description: '',
                id: Date.now() + Math.random()
              }));
              setSupportingFiles((prev) => [...prev, ...files]);
            }}
          />

          {supportingFiles.length > 0 && (
            <ul className="file-list">
              {supportingFiles.map((fileObj, index) => (
                <li key={fileObj.id}>
                  <div className="file-entry">
                    <span className="file-name">{fileObj.file.name}</span>
                    <input
                      type="text"
                      placeholder="Add description..."
                      value={fileObj.description}
                      onChange={(evt) => {
                        const updated = supportingFiles.map((item, i) =>
                          i === index
                            ? { ...item, description: evt.target.value }
                            : item
                        );
                        setSupportingFiles(updated);
                      }}
                      className="description-input"
                    />
                    <button
                      onClick={() =>
                        setSupportingFiles((prev) =>
                          prev.filter((_, i) => i !== index)
                        )
                      }
                      className="remove-button"
                    >
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="form-group">
          <div className="label-with-tooltip">
            <label>Add IPFS CID</label>
            <div
              className="tooltip-trigger"
              onMouseEnter={() => setActiveTooltipId('ipfs')}
              onMouseLeave={() => setActiveTooltipId(null)}
            >
              ⓘ
              {activeTooltipId === 'ipfs' && (
                <div className="tooltip-content">
                  Enter Content IDs (CIDs) from IPFS to include external data in
                  your query.
                </div>
              )}
            </div>
          </div>
          <div className="cid-input-group">
            <input
              type="text"
              value={cidInput}
              onChange={(e) => setCidInput(e.target.value)}
              placeholder="Enter IPFS CID..."
            />
            <button
              onClick={() => {
                if (cidInput.trim()) {
                  const newCid = {
                    cid: cidInput.trim(),
                    name: `supportFile${ipfsCids.length + 1}`,
                    description: '',
                    id: Date.now() + Math.random()
                  };
                  setIpfsCids((prev) => [...prev, newCid]);
                  setCidInput('');
                }
              }}
            >
              Add CID
            </button>
          </div>

          {ipfsCids.length > 0 && (
            <ul className="cid-list">
              {ipfsCids.map((cidObj, index) => (
                <li key={cidObj.id}>
                  <div className="cid-entry">
                    <span className="cid-name">{cidObj.name}</span>
                    <span className="cid-value">{cidObj.cid}</span>
                    <input
                      type="text"
                      placeholder="Add description..."
                      value={cidObj.description}
                      onChange={(evt) => {
                        const updated = ipfsCids.map((item, i) =>
                          i === index
                            ? { ...item, description: evt.target.value }
                            : item
                        );
                        setIpfsCids(updated);
                      }}
                      className="description-input"
                    />
                    <button
                      onClick={() =>
                        setIpfsCids((prev) => prev.filter((_, i) => i !== index))
                      }
                      className="remove-button"
                    >
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="form-group">
          <div className="label-with-tooltip">
            <label>Add Reference URLs</label>
            <div
              className="tooltip-trigger"
              onMouseEnter={() => setActiveTooltipId('urls')}
              onMouseLeave={() => setActiveTooltipId(null)}
            >
              ⓘ
              {activeTooltipId === 'urls' && (
                <div className="tooltip-content">
                  Add URLs to online resources that the AI Jury should consider when evaluating the query.
                </div>
              )}
            </div>
          </div>
          <div className="url-input-group">
            <input
              type="text"
              value={linkInput}
              onChange={(e) => setLinkInput(e.target.value)}
              placeholder="Enter URL (https://...)..."
              className="url-input"
            />
            <button
              onClick={() => {
                if (linkInput.trim()) {
                  try {
                    // Basic URL validation
                    new URL(linkInput.trim());
                    const newUrl = {
                      url: linkInput.trim(),
                      description: '',
                      id: Date.now() + Math.random()
                    };
                    setHyperlinks((prev) => [...prev, newUrl]);
                    setLinkInput('');
                  } catch (e) {
                    alert('Please enter a valid URL including http:// or https://');
                  }
                }
              }}
            >
              Add URL
            </button>
          </div>

          {hyperlinks.length > 0 && (
            <ul className="url-list">
              {hyperlinks.map((urlObj, index) => (
                <li key={urlObj.id}>
                  <div className="url-entry">
                    <a 
                      href={urlObj.url} 
                      target="_blank" 
                      rel="noopener noreferrer" 
                      className="url-value"
                    >
                      {urlObj.url}
                    </a>
                    <input
                      type="text"
                      placeholder="Add description..."
                      value={urlObj.description}
                      onChange={(evt) => {
                        const updated = hyperlinks.map((item, i) =>
                          i === index
                            ? { ...item, description: evt.target.value }
                            : item
                        );
                        setHyperlinks(updated);
                      }}
                      className="description-input"
                    />
                    <button
                      onClick={() =>
                        setHyperlinks((prev) => prev.filter((_, i) => i !== index))
                      }
                      className="remove-button"
                    >
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <div className="actions">
        <button
          className="primary"
          onClick={() => setCurrentPage(PAGES.JURY_SELECTION)}
          disabled={!queryText || !queryText.trim()}
        >
          Next: Jury Selection
        </button>
      </div>
    </div>
  );
}

export default QueryDefinition;