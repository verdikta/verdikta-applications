// src/components/ClassSelector.jsx
import { useState, useEffect } from 'react';
import { classMapService } from '../services/classMapService';
import './ClassSelector.css';

function ClassSelector({
  selectedClassId,
  onClassSelect,
  isLoading: externalLoading,
  error: externalError
}) {
  const [classes, setClasses] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [manualClassId, setManualClassId] = useState('');

  // Load available classes on component mount
  useEffect(() => {
    const loadClasses = async () => {
      setIsLoading(true);
      setError(null);

      try {
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

  // Handle class selection from cards
  const handleClassSelect = (classId) => {
    if (onClassSelect) {
      onClassSelect(classId);
    }
  };

  // Handle manual class ID selection
  const handleManualSelect = () => {
    const classId = parseInt(manualClassId, 10);
    if (!isNaN(classId) && classId > 0) {
      onClassSelect(classId);
      setManualClassId('');
    }
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
        <h3>🎯 Select AI Class</h3>
        <div className="current-selection">
          Currently Selected: <strong>Class {selectedClassId}</strong>
        </div>
      </div>

      {/* Manual Class ID Entry */}
      <div className="manual-entry-section">
        <div className="manual-entry-form">
          <label htmlFor="manual-class-id">Or enter custom class ID:</label>
          <div className="manual-entry-inputs">
            <input
              type="number"
              id="manual-class-id"
              value={manualClassId}
              onChange={(e) => setManualClassId(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleManualSelect();
                }
              }}
              placeholder="e.g., 3030"
              min="1"
              className="manual-class-input"
            />
            <button 
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleManualSelect();
              }}
              className="btn btn-sm btn-secondary"
              disabled={!manualClassId || isNaN(parseInt(manualClassId, 10))}
            >
              Use Class
            </button>
          </div>
        </div>
      </div>

      {/* Class Cards */}
      <div className="class-cards">
        {classes.map((cls) => (
          <ClassCard
            key={cls.id}
            classData={cls}
            isSelected={selectedClassId === cls.id}
            onSelect={() => handleClassSelect(cls.id)}
          />
        ))}
      </div>
    </div>
  );
}

// Individual class card component
function ClassCard({ classData, isSelected, onSelect }) {
  const [detailedInfo, setDetailedInfo] = useState(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

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

  const getCardClasses = () => {
    const baseClass = 'class-card';
    const classes = [baseClass];

    if (isSelected) classes.push('selected');
    if (classData.status === 'EMPTY') classes.push('empty');
    if (classData.status === 'DEPRECATED') classes.push('deprecated');
    if (classData.status !== 'ACTIVE') classes.push('disabled');

    return classes.join(' ');
  };

  const handleClick = () => {
    if (classData.status === 'EMPTY') return;
    onSelect();
  };

  const getDisplayStats = () => {
    if (classData.status === 'EMPTY') {
      return {
        models: 0,
        maxModels: '--',
        maxRuns: '--',
        maxIterations: '--'
      };
    }

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
      <div className="card-header">
        <div className="class-id">Class {classData.id}</div>
        <div className={`status-badge ${classData.status.toLowerCase()}`}>
          {classData.status}
        </div>
      </div>

      <div className="card-content">
        <div className="class-name">{classData.name}</div>
      </div>

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

      {isSelected && (
        <div className="selection-indicator">
          ✓ SELECTED
        </div>
      )}

      {loadingDetails && (
        <div className="loading-overlay">
          <div className="loading-spinner"></div>
        </div>
      )}
    </div>
  );
}

export default ClassSelector;

