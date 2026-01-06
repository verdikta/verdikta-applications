import './ModelStatusGrid.css';

/**
 * ModelStatusGrid - Displays the status of individual AI models in the jury
 * 
 * Features:
 * - Visual grid showing each model's success/failure status
 * - Duration information for each model
 * - Error details on hover/click
 * - Status icons and color coding
 * 
 * @param {Array} modelResults - Array of model result objects from justification metadata
 */
function ModelStatusGrid({ modelResults }) {
  if (!modelResults || modelResults.length === 0) {
    return null;
  }

  const getStatusIcon = (status) => {
    switch (status) {
      case 'success':
        return '✅';
      case 'failed':
        return '❌';
      case 'timeout':
        return '⏱️';
      case 'parsing_error':
        return '⚠️';
      default:
        return '❓';
    }
  };

  const getStatusClass = (status) => {
    switch (status) {
      case 'success':
        return 'status-success';
      case 'failed':
        return 'status-failed';
      case 'timeout':
        return 'status-timeout';
      case 'parsing_error':
        return 'status-parsing-error';
      default:
        return 'status-unknown';
    }
  };

  const formatDuration = (ms) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  return (
    <div className="model-status-grid">
      <h4 className="grid-title">Model Performance</h4>
      <div className="model-grid">
        {modelResults.map((model, index) => (
          <div
            key={index}
            className={`model-card ${getStatusClass(model.status)}`}
            title={
              model.error_message
                ? `Error: ${model.error_message}`
                : `Completed in ${formatDuration(model.duration_ms || 0)}`
            }
          >
            <div className="model-header">
              <span className="status-icon">{getStatusIcon(model.status)}</span>
              <span className="model-name">{model.model}</span>
            </div>
            <div className="model-provider">{model.provider}</div>
            <div className="model-duration">{formatDuration(model.duration_ms || 0)}</div>
            
            {model.error_message && (
              <div className="model-error-preview">
                {model.error_type && <span className="error-type">{model.error_type}</span>}
                <span className="error-message">{model.error_message.substring(0, 50)}...</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default ModelStatusGrid;

