// Class selection component with card-based UI
import React, { useState, useEffect } from 'react';
import { classMapService } from '../services/classMapService';
import './ClassSelector.css';

function ClassSelector({ 
  selectedClassId, 
  onClassSelect, 
  isLoading: externalLoading,
  error: externalError,
  overrideClassInfo = null
}) {
  const [classes, setClasses] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  
  // Override functionality state
  const [showOverride, setShowOverride] = useState(false);
  const [overrideClassId, setOverrideClassId] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  
  // Determine if we're in override mode based on props
  const isOverrideMode = overrideClassInfo && overrideClassInfo.isOverride;

  // Load available classes on component mount
  useEffect(() => {
    const loadClasses = async () => {
      setIsLoading(true);
      setError(null);
      
      try {
        // Get all classes (not just active ones for better discoverability)
        const allClasses = await classMapService.getClasses();
        setClasses(allClasses);
      } catch (err) {
        console.error('Error loading classes:', err);
        setError(err.message);
      } finally {
        setIsLoading(false);
      }
    };

    loadClasses();
  }, []);

  // Reset override form when override section is opened
  useEffect(() => {
    if (showOverride) {
      setOverrideClassId('');
      setSelectedTemplate(null);
      console.log('🔄 Override form reset - ID:', overrideClassId, 'Template:', selectedTemplate);
    }
  }, [showOverride]);

  // Handle class selection
  const handleClassSelect = (classId) => {
    // Clear override mode by calling with null override info
    if (onClassSelect) {
      onClassSelect(classId, null);
    }
  };

  // Check if a class ID is supported (exists in the official list)
  const isSupportedClass = (classId) => {
    return classes.some(cls => cls.id === classId);
  };

  // Handle override class selection
  const handleOverrideSubmit = () => {
    const customClassId = parseInt(overrideClassId, 10);
    
    console.log('🧪 Override Submit - Input:', overrideClassId, 'Parsed:', customClassId);
    
    if (isNaN(customClassId) || customClassId < 0) {
      alert('Please enter a valid class ID (positive number)');
      return;
    }

    if (isSupportedClass(customClassId)) {
      alert('This class ID is already supported. Please select it from the cards above.');
      return;
    }

    if (!selectedTemplate) {
      alert('Please select a template class to use for models and limits.');
      return;
    }

    // Create override class info
    const overrideClass = {
      id: customClassId,
      name: `Custom Class ${customClassId} (Override)`,
      status: 'OVERRIDE',
      templateClass: selectedTemplate,
      isOverride: true
    };

    console.log('🧪 Override Class Created:', overrideClass);
    
    setShowOverride(false);
    
    if (onClassSelect) {
      console.log('🧪 Calling onClassSelect with:', customClassId, overrideClass);
      onClassSelect(customClassId, overrideClass);
    }
  };

  // Reset override mode
  const handleCancelOverride = () => {
    setShowOverride(false);
    setOverrideClassId('');
    setSelectedTemplate(null);
  };

  // Get active (non-empty) classes for template selection
  const getActiveClasses = () => {
    return classes.filter(cls => cls.status === 'ACTIVE');
  };

  // Render loading state
  if (isLoading || externalLoading) {
    return (
      <div className="class-selector">
        <h3>🎯 Select AI Class</h3>
        <div className="class-cards">
          {[1, 2, 3].map(i => (
            <div key={i} className="class-card skeleton">
              <div className="skeleton-header"></div>
              <div className="skeleton-content"></div>
              <div className="skeleton-stats"></div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Render error state
  if (error || externalError) {
    return (
      <div className="class-selector">
        <h3>🎯 Select AI Class</h3>
        <div className="error-state">
          <p>❌ Failed to load classes: {error || externalError}</p>
          <button 
            className="retry-button"
            onClick={() => window.location.reload()}
          >
            🔄 Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="class-selector">
      <div className="class-selector-header">
        <div className="header-left">
          <h3>🎯 Select AI Class</h3>
          <div className="current-selection">
            Currently Selected: <strong>Class {selectedClassId}</strong>
            {isOverrideMode && overrideClassInfo && (
              <span className="override-indicator">
                (Override - Template: Class {overrideClassInfo.templateClass?.id})
              </span>
            )}
          </div>
        </div>
        <button 
          className="override-toggle-button"
          onClick={() => {
            console.log('🎛️ Toggle override section:', !showOverride);
            setShowOverride(!showOverride);
          }}
          title="Use custom class ID for testing"
        >
          {showOverride ? '✕ Cancel Override' : '⚙️ Custom Class ID'}
        </button>
      </div>

      {/* Override Mode Warning */}
      {isOverrideMode && !isSupportedClass(selectedClassId) && (
        <div className="override-warning">
          ⚠️ <strong>Testing Mode:</strong> Using unsupported Class ID {selectedClassId} with template models. 
          This is for testing purposes only.
        </div>
      )}

      {/* Override Input Section */}
      {showOverride && (
        <div className="override-section">
          <h4>🧪 Custom Class ID (Testing)</h4>
          <p className="override-description">
            Enter a custom class ID and select which supported class's models to use as a template.
          </p>
          
          {/* Debug Information */}
          <div className="debug-info">
            <small style={{ color: '#6c757d', fontSize: '0.8rem' }}>
              Debug: overrideClassId="{overrideClassId}", selectedTemplate={selectedTemplate?.id || 'null'}, 
              buttonDisabled={!overrideClassId || !selectedTemplate ? 'true' : 'false'}
            </small>
          </div>
          
          <div className="override-form">
            <div className="override-input-group">
              <label htmlFor="override-class-id">Custom Class ID:</label>
              <input
                id="override-class-id"
                type="number"
                value={overrideClassId}
                onChange={(e) => {
                  console.log('📝 Override class ID input changed:', e.target.value);
                  setOverrideClassId(e.target.value);
                }}
                placeholder="e.g. 1001"
                min="0"
                className="override-input"
              />
            </div>
            
            <div className="template-selection">
              <label>Select Template Class (for models & limits):</label>
              <div className="template-options">
                {getActiveClasses().map((cls) => (
                  <button
                    key={cls.id}
                    className={`template-option ${selectedTemplate?.id === cls.id ? 'selected' : ''}`}
                    onClick={() => {
                      console.log('🎯 Template selected:', cls);
                      setSelectedTemplate(cls);
                    }}
                  >
                    <span className="template-id">Class {cls.id}</span>
                    <span className="template-name">{cls.name}</span>
                  </button>
                ))}
              </div>
            </div>
            
            <div className="override-actions">
              <button 
                className="override-submit-button"
                onClick={handleOverrideSubmit}
                disabled={!overrideClassId || !selectedTemplate}
                title={
                  !overrideClassId ? 'Please enter a custom class ID' :
                  !selectedTemplate ? 'Please select a template class' :
                  'Click to use custom class'
                }
              >
                Use Custom Class
                {(!overrideClassId || !selectedTemplate) && (
                  <span className="button-debug"> 
                    (ID: {overrideClassId || 'missing'}, Template: {selectedTemplate?.id || 'missing'})
                  </span>
                )}
              </button>
              <button 
                className="override-cancel-button"
                onClick={handleCancelOverride}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Regular Class Cards */}
      <div className="class-cards">
        {classes.map((cls) => (
          <ClassCard
            key={cls.id}
            classData={cls}
            isSelected={selectedClassId === cls.id && !isOverrideMode}
            onSelect={() => handleClassSelect(cls.id)}
          />
        ))}
        
        {/* Override Class Card (when active) */}
        {isOverrideMode && !isSupportedClass(selectedClassId) && overrideClassInfo && (
          <div className="class-card override-card selected">
            <div className="card-header">
              <div className="class-id">Class {selectedClassId}</div>
              <div className="status-badge override">OVERRIDE</div>
            </div>
            <div className="card-content">
              <div className="class-name">Custom Class (Testing)</div>
              <div className="template-info">
                Template: Class {overrideClassInfo.templateClass?.id} - {overrideClassInfo.templateClass?.name}
              </div>
            </div>
            <div className="selection-indicator">
              ✓ SELECTED
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Individual class card component
function ClassCard({ classData, isSelected, onSelect }) {
  const [detailedInfo, setDetailedInfo] = useState(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  // Load detailed class information on hover/focus for better UX
  const loadDetails = async () => {
    if (detailedInfo || loadingDetails || classData.status !== 'ACTIVE') return;
    
    setLoadingDetails(true);
    try {
      const details = await classMapService.getClass(classData.id);
      setDetailedInfo(details);
    } catch (err) {
      console.warn('Failed to load class details:', err);
    } finally {
      setLoadingDetails(false);
    }
  };

  // Get card CSS classes
  const getCardClasses = () => {
    const baseClass = 'class-card';
    const classes = [baseClass];
    
    if (isSelected) classes.push('selected');
    if (classData.status === 'EMPTY') classes.push('empty');
    if (classData.status === 'DEPRECATED') classes.push('deprecated');
    if (classData.status !== 'ACTIVE') classes.push('disabled');
    
    return classes.join(' ');
  };

  // Handle click
  const handleClick = () => {
    if (classData.status === 'EMPTY') return; // Don't allow selection of empty classes
    onSelect();
  };

  // Get display stats
  const getDisplayStats = () => {
    if (classData.status === 'EMPTY') {
      return {
        models: 0,
        maxModels: '--',
        maxRuns: '--',
        maxIterations: '--'
      };
    }

    // Use detailed info if available, otherwise show loading or basic info
    if (detailedInfo && detailedInfo.limits) {
      return {
        models: detailedInfo.models?.length || 0,
        maxModels: detailedInfo.limits.max_panel_size,
        maxRuns: detailedInfo.limits.max_no_counts,
        maxIterations: detailedInfo.limits.max_iterations
      };
    }

    return {
      models: '...',
      maxModels: '...',
      maxRuns: '...',
      maxIterations: '...'
    };
  };

  const stats = getDisplayStats();

  return (
    <div 
      className={getCardClasses()}
      onClick={handleClick}
      onMouseEnter={loadDetails}
      onFocus={loadDetails}
      tabIndex={classData.status !== 'EMPTY' ? 0 : -1}
      role="button"
      aria-pressed={isSelected}
      aria-disabled={classData.status === 'EMPTY'}
      title={
        classData.status === 'EMPTY' 
          ? 'This class has no available models'
          : classData.status === 'DEPRECATED'
            ? 'This class is deprecated but still functional'
            : `Select ${classData.name}`
      }
    >
      {/* Card Header */}
      <div className="card-header">
        <div className="class-id">Class {classData.id}</div>
        <div className={`status-badge ${classData.status.toLowerCase()}`}>
          {classData.status}
        </div>
      </div>

      {/* Card Content */}
      <div className="card-content">
        <div className="class-name">{classData.name}</div>
      </div>

      {/* Card Stats */}
      <div className="card-stats">
        <div className="stat">
          <span className="stat-label">Models:</span>
          <span className="stat-value">{stats.models}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Max:</span>
          <span className="stat-value">{stats.maxModels}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Runs:</span>
          <span className="stat-value">{stats.maxRuns}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Iter:</span>
          <span className="stat-value">{stats.maxIterations}</span>
        </div>
      </div>

      {/* Selection Indicator */}
      {isSelected && (
        <div className="selection-indicator">
          ✓ SELECTED
        </div>
      )}

      {/* Loading Overlay for Details */}
      {loadingDetails && (
        <div className="loading-overlay">
          <div className="loading-spinner"></div>
        </div>
      )}
    </div>
  );
}

export default ClassSelector;
