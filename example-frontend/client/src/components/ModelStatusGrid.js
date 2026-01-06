// src/components/ModelStatusGrid.js
import React from 'react';

/**
 * ModelStatusGrid - Displays AI model performance in the jury
 * Styled with Tailwind CSS to match example-frontend design
 */
const ModelStatusGrid = ({ modelResults }) => {
  if (!modelResults || modelResults.length === 0) {
    return null;
  }

  const getStatusConfig = (status) => {
    switch (status) {
      case 'success':
        return {
          icon: '✅',
          bgColor: 'bg-green-50',
          borderColor: 'border-green-300',
          textColor: 'text-green-700'
        };
      case 'failed':
        return {
          icon: '❌',
          bgColor: 'bg-red-50',
          borderColor: 'border-red-300',
          textColor: 'text-red-700'
        };
      case 'timeout':
        return {
          icon: '⏱️',
          bgColor: 'bg-amber-50',
          borderColor: 'border-amber-300',
          textColor: 'text-amber-700'
        };
      case 'parsing_error':
        return {
          icon: '⚠️',
          bgColor: 'bg-yellow-50',
          borderColor: 'border-yellow-300',
          textColor: 'text-yellow-700'
        };
      default:
        return {
          icon: '❓',
          bgColor: 'bg-gray-50',
          borderColor: 'border-gray-300',
          textColor: 'text-gray-700'
        };
    }
  };

  const formatDuration = (ms) => {
    if (!ms) return 'N/A';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  return (
    <div style={{ 
      marginBottom: '1.5rem',
      backgroundColor: '#f8f9fa',
      padding: '1rem',
      borderRadius: '8px',
      border: '1px solid #e0e0e0'
    }}>
      <h4 style={{
        fontSize: '0.875rem',
        fontWeight: '600',
        color: '#555',
        marginBottom: '0.875rem',
        letterSpacing: '0.3px'
      }}>
        Model Performance
      </h4>
      
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
        gap: '0.75rem'
      }}>
        {modelResults.map((model, index) => {
          const config = getStatusConfig(model.status);
          return (
            <div
              key={index}
              style={{
                backgroundColor: config.bgColor === 'bg-green-50' ? '#f1f8f4' :
                                config.bgColor === 'bg-red-50' ? '#ffebee' :
                                config.bgColor === 'bg-amber-50' ? '#fff8e1' :
                                config.bgColor === 'bg-yellow-50' ? '#fffde7' : '#fafafa',
                border: `2px solid ${
                  config.borderColor === 'border-green-300' ? '#81c784' :
                  config.borderColor === 'border-red-300' ? '#e57373' :
                  config.borderColor === 'border-amber-300' ? '#ffb74d' :
                  config.borderColor === 'border-yellow-300' ? '#ffd54f' : '#bdbdbd'
                }`,
                borderRadius: '6px',
                padding: '0.75rem',
                transition: 'all 0.2s ease',
                cursor: model.error_message ? 'help' : 'default'
              }}
              title={model.error_message || `Completed in ${formatDuration(model.duration_ms)}`}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.375rem' }}>
                <span style={{ fontSize: '1.125rem' }}>{config.icon}</span>
                <span style={{
                  fontWeight: '600',
                  fontSize: '0.8rem',
                  color: '#333',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1
                }}>
                  {model.model}
                </span>
              </div>
              
              <div style={{ fontSize: '0.7rem', color: '#666', marginBottom: '0.25rem' }}>
                {model.provider}
              </div>
              
              <div style={{ fontSize: '0.7rem', color: '#888', fontFamily: 'monospace' }}>
                {formatDuration(model.duration_ms)}
              </div>
              
              {model.error_message && (
                <div style={{
                  marginTop: '0.5rem',
                  padding: '0.375rem',
                  backgroundColor: 'rgba(255,255,255,0.6)',
                  borderRadius: '4px',
                  fontSize: '0.7rem'
                }}>
                  {model.error_type && (
                    <span style={{
                      display: 'inline-block',
                      padding: '0.125rem 0.375rem',
                      backgroundColor: '#f44336',
                      color: 'white',
                      borderRadius: '3px',
                      fontSize: '0.6rem',
                      fontWeight: '600',
                      textTransform: 'uppercase',
                      marginRight: '0.25rem'
                    }}>
                      {model.error_type}
                    </span>
                  )}
                  <span style={{ color: '#555', fontStyle: 'italic' }}>
                    {model.error_message.length > 50 
                      ? model.error_message.substring(0, 50) + '...' 
                      : model.error_message}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ModelStatusGrid;

