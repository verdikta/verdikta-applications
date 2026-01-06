import { useState } from 'react';
import './WarningsList.css';

/**
 * WarningsList - Displays warnings from the evaluation process
 * 
 * Features:
 * - Collapsible design to avoid clutter
 * - Severity-based styling (info, warning, error)
 * - Clear categorization
 * - Expandable details
 * 
 * @param {Array} warnings - Array of warning objects from justification
 */
function WarningsList({ warnings }) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!warnings || warnings.length === 0) {
    return null;
  }

  const getSeverityIcon = (severity) => {
    switch (severity) {
      case 'info':
        return 'ℹ️';
      case 'warning':
        return '⚠️';
      case 'error':
        return '❌';
      default:
        return '•';
    }
  };

  const getSeverityClass = (severity) => {
    switch (severity) {
      case 'info':
        return 'severity-info';
      case 'warning':
        return 'severity-warning';
      case 'error':
        return 'severity-error';
      default:
        return 'severity-default';
    }
  };

  const groupedWarnings = warnings.reduce((groups, warning) => {
    const severity = warning.severity || 'warning';
    if (!groups[severity]) {
      groups[severity] = [];
    }
    groups[severity].push(warning);
    return groups;
  }, {});

  const severityOrder = ['error', 'warning', 'info'];
  const sortedGroups = severityOrder
    .filter(severity => groupedWarnings[severity])
    .map(severity => ({
      severity,
      warnings: groupedWarnings[severity]
    }));

  return (
    <div className="warnings-list">
      <button
        className="warnings-toggle"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span className="toggle-icon">{isExpanded ? '▼' : '▶'}</span>
        <span className="toggle-text">
          {warnings.length} {warnings.length === 1 ? 'Notice' : 'Notices'}
        </span>
        <span className="severity-badges">
          {groupedWarnings.error && (
            <span className="badge badge-error">{groupedWarnings.error.length} errors</span>
          )}
          {groupedWarnings.warning && (
            <span className="badge badge-warning">{groupedWarnings.warning.length} warnings</span>
          )}
          {groupedWarnings.info && (
            <span className="badge badge-info">{groupedWarnings.info.length} info</span>
          )}
        </span>
      </button>

      {isExpanded && (
        <div className="warnings-content">
          {sortedGroups.map(({ severity, warnings: items }) => (
            <div key={severity} className={`warning-group ${getSeverityClass(severity)}`}>
              <div className="group-header">
                <span className="severity-icon">{getSeverityIcon(severity)}</span>
                <span className="severity-label">{severity.toUpperCase()}</span>
                <span className="group-count">({items.length})</span>
              </div>
              
              <ul className="warning-items">
                {items.map((warning, index) => (
                  <li key={index} className="warning-item">
                    <div className="warning-message">{warning.message}</div>
                    {warning.model && (
                      <div className="warning-model">Model: {warning.model}</div>
                    )}
                    {warning.details && Object.keys(warning.details).length > 0 && (
                      <details className="warning-details">
                        <summary>Technical Details</summary>
                        <pre>{JSON.stringify(warning.details, null, 2)}</pre>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default WarningsList;

