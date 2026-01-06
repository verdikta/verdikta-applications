// src/components/WarningsList.js
import React, { useState } from 'react';

/**
 * WarningsList - Displays evaluation warnings with severity indicators
 * Styled with Tailwind CSS to match example-frontend design
 */
const WarningsList = ({ warnings }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!warnings || warnings.length === 0) {
    return null;
  }

  const getSeverityConfig = (severity) => {
    switch (severity) {
      case 'info':
        return {
          icon: 'ℹ️',
          bgColor: 'bg-blue-100',
          textColor: 'text-blue-800',
          badgeBg: 'bg-blue-200',
          badgeText: 'text-blue-900'
        };
      case 'warning':
        return {
          icon: '⚠️',
          bgColor: 'bg-amber-100',
          textColor: 'text-amber-800',
          badgeBg: 'bg-amber-200',
          badgeText: 'text-amber-900'
        };
      case 'error':
        return {
          icon: '❌',
          bgColor: 'bg-red-100',
          textColor: 'text-red-800',
          badgeBg: 'bg-red-200',
          badgeText: 'text-red-900'
        };
      default:
        return {
          icon: '•',
          bgColor: 'bg-gray-100',
          textColor: 'text-gray-800',
          badgeBg: 'bg-gray-200',
          badgeText: 'text-gray-900'
        };
    }
  };

  // Group warnings by severity
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
      warnings: groupedWarnings[severity],
      config: getSeverityConfig(severity)
    }));

  return (
    <div style={{
      marginBottom: '1.5rem',
      backgroundColor: '#fffbf0',
      border: '2px solid #ffe082',
      borderRadius: '8px',
      overflow: 'hidden'
    }}>
      {/* Toggle Button */}
      <button
        style={{
          width: '100%',
          padding: '0.75rem 1rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          backgroundColor: 'transparent',
          border: 'none',
          cursor: 'pointer',
          transition: 'background-color 0.2s ease'
        }}
        onClick={() => setIsExpanded(!isExpanded)}
        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#fff9e6'}
        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
      >
        <span style={{ fontSize: '0.75rem', fontFamily: 'monospace', minWidth: '14px' }}>
          {isExpanded ? '▼' : '▶'}
        </span>
        <span style={{ flex: 1, textAlign: 'left', fontSize: '0.875rem', fontWeight: '600', color: '#e65100' }}>
          {warnings.length} {warnings.length === 1 ? 'Notice' : 'Notices'}
        </span>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {groupedWarnings.error && (
            <span style={{
              padding: '0.25rem 0.625rem',
              backgroundColor: '#ffcdd2',
              color: '#c62828',
              borderRadius: '12px',
              fontSize: '0.7rem',
              fontWeight: '600',
              textTransform: 'uppercase'
            }}>
              {groupedWarnings.error.length} errors
            </span>
          )}
          {groupedWarnings.warning && (
            <span style={{
              padding: '0.25rem 0.625rem',
              backgroundColor: '#ffe0b2',
              color: '#e65100',
              borderRadius: '12px',
              fontSize: '0.7rem',
              fontWeight: '600',
              textTransform: 'uppercase'
            }}>
              {groupedWarnings.warning.length} warnings
            </span>
          )}
          {groupedWarnings.info && (
            <span style={{
              padding: '0.25rem 0.625rem',
              backgroundColor: '#bbdefb',
              color: '#1565c0',
              borderRadius: '12px',
              fontSize: '0.7rem',
              fontWeight: '600',
              textTransform: 'uppercase'
            }}>
              {groupedWarnings.info.length} info
            </span>
          )}
        </div>
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div style={{
          padding: '1rem',
          borderTop: '1px solid rgba(0,0,0,0.08)',
          backgroundColor: 'white'
        }}>
          {sortedGroups.map(({ severity, warnings: items, config }) => (
            <div
              key={severity}
              style={{
                marginBottom: '0.75rem',
                borderRadius: '6px',
                overflow: 'hidden',
                border: '1px solid rgba(0,0,0,0.1)'
              }}
            >
              <div style={{
                padding: '0.5rem 0.75rem',
                backgroundColor: 
                  severity === 'info' ? '#e3f2fd' :
                  severity === 'warning' ? '#fff3e0' :
                  severity === 'error' ? '#ffebee' : '#f5f5f5',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                borderBottom: '1px solid rgba(0,0,0,0.06)'
              }}>
                <span style={{ fontSize: '1rem' }}>{config.icon}</span>
                <span style={{
                  fontWeight: '700',
                  fontSize: '0.75rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  color: severity === 'info' ? '#0d47a1' :
                         severity === 'warning' ? '#e65100' :
                         severity === 'error' ? '#b71c1c' : '#666'
                }}>
                  {severity}
                </span>
                <span style={{ fontSize: '0.7rem', opacity: 0.7 }}>({items.length})</span>
              </div>
              
              <div style={{ backgroundColor: 'white' }}>
                {items.map((warning, index) => (
                  <div
                    key={index}
                    style={{
                      padding: '0.75rem',
                      borderTop: index > 0 ? '1px solid rgba(0,0,0,0.06)' : 'none'
                    }}
                  >
                    <div style={{
                      fontSize: '0.875rem',
                      lineHeight: '1.5',
                      color: '#333',
                      marginBottom: '0.25rem'
                    }}>
                      {warning.message}
                    </div>
                    {warning.model && (
                      <div style={{
                        fontSize: '0.75rem',
                        color: '#666',
                        fontFamily: 'monospace',
                        marginTop: '0.25rem'
                      }}>
                        Model: {warning.model}
                      </div>
                    )}
                    {warning.details && Object.keys(warning.details).length > 0 && (
                      <details style={{ marginTop: '0.5rem' }}>
                        <summary style={{
                          fontSize: '0.75rem',
                          color: '#1976d2',
                          fontWeight: '600',
                          cursor: 'pointer',
                          userSelect: 'none'
                        }}>
                          Technical Details
                        </summary>
                        <pre style={{
                          marginTop: '0.5rem',
                          padding: '0.5rem',
                          backgroundColor: '#f5f5f5',
                          borderRadius: '4px',
                          fontSize: '0.7rem',
                          overflowX: 'auto',
                          border: '1px solid #ddd'
                        }}>
                          {JSON.stringify(warning.details, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default WarningsList;

