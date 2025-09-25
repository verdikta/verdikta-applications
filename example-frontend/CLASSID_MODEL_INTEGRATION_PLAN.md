# ClassID → Model Pool Integration Plan

## Overview

This document outlines the implementation plan for integrating the new ClassID → Model Pool mapping functionality from `@verdikta/common` into the example-frontend application. This enhancement will dynamically update the available AI models based on the selected contract's class ID.

## Current Architecture Analysis

### Current State
- **Contract Selection**: Users select contracts from a dropdown in the header (`App.js` lines 304-339)
- **Class ID Management**: Each contract has an associated class ID (default: 128) stored in `server/data/contracts.json`
- **Model Selection**: Static hardcoded model list in `JurySelection.js` (lines 17-21):
  ```javascript
  const providerModels = {
    OpenAI: ['gpt-3.5-turbo', 'gpt-4', 'gpt-4o'],
    Anthropic: ['claude-2.1', 'claude-3-sonnet-20240229', 'claude-3-5-sonnet-20241022'],
    'Open-source': ['llava', 'llama-3.1', 'llama-3.2', 'phi3']
  };
  ```
- **verdikta-common Usage**: Currently used for archive/manifest services, but not for ClassID mapping

### Current Flow
1. User selects contract → `selectedContractClass` state is updated (App.js line 315)
2. User navigates to Jury Selection page
3. Static model list is displayed regardless of class ID
4. User manually selects models from hardcoded list

## New ClassID → Model Pool Mapping

### Available Classes (from docs)
| ClassID | Name                       | Status | Providers         | Models                                          |
|---------|----------------------------|--------|-------------------|-------------------------------------------------|
| 128     | OpenAI & Anthropic Core    | ACTIVE | openai, anthropic | gpt-5, gpt-5-mini, claude-sonnet-4             |
| 129     | Open-Source Local (Ollama) | ACTIVE | ollama            | llama3.1:8b, llava:7b, deepseek-r1:8b, qwen3:8b |
| 130     | OSS via Hyperbolic API     | EMPTY  | (reserved)        | (none)                                          |

### ClassMap API Functions
- `getClass(classId)` - Get class specification
- `listClasses(filter)` - List classes with optional filtering
- `isTracked(classId)` - Check if classId is in curated range
- `validateQueryAgainstClass(manifest, classId)` - Validate manifest against class limits

## Implementation Plan

### Phase 1: Backend Integration

#### 1.1 Server-Side ClassMap Integration
**File**: `server/server.js`
- Import `classMap` from `@verdikta/common`
- Add new API endpoint: `GET /api/classes/:classId/models`
- Add new API endpoint: `GET /api/classes` (list all active classes)
- Add validation endpoint: `POST /api/classes/:classId/validate`

#### 1.2 Contract Management Enhancement
**File**: `server/routes/contractRoutes.js`
- Enhance contract validation to check if classId is valid using `classMap.getClass()`
- Add warning for deprecated/empty classes
- Return class status information with contract data

### Phase 2: Frontend Service Layer

#### 2.1 ClassMap Service Creation
**File**: `client/src/services/classMapService.js` (NEW)
- Create browser-compatible wrapper for classMap functionality
- Implement caching for class data to reduce API calls
- Handle error states (unknown classes, empty classes, network errors)

```javascript
export class ClassMapService {
  async getAvailableModels(classId)
  async getClassInfo(classId)
  async validateManifest(manifest, classId)
  // ... other methods
}
```

#### 2.2 Model Provider Service
**File**: `client/src/services/modelProviderService.js` (NEW)
- Transform classMap model data into UI-friendly format
- Handle provider-specific model configurations
- Manage model availability status

### Phase 3: Frontend Component Updates

#### 3.1 App.js State Management
**Changes needed**:
- Add `availableModels` state
- Add `classInfo` state for current class details
- Add `isLoadingModels` state
- Create effect to fetch models when `selectedContractClass` changes
- Pass model data to JurySelection component

#### 3.2 JurySelection Component Overhaul
**File**: `client/src/pages/JurySelection.js`
**Changes needed**:
- Remove hardcoded `providerModels` object
- Accept `availableModels` and `classInfo` as props
- Add loading state for model fetching
- Add error handling for empty/invalid classes
- Update model selection logic to use dynamic data
- Add class information display (class name, status, limits)

#### 3.3 Contract Management Enhancement
**File**: `client/src/pages/ContractManagement.js`
**Changes needed**:
- Add real-time class validation during input
- Display class status (ACTIVE/DEPRECATED/EMPTY) in contract list
- Show warning icons for problematic classes
- Add class information tooltip/modal

#### 3.4 Run Query Validation
**File**: `client/src/pages/RunQuery.js`
**Changes needed**:
- Integrate manifest validation using classMap
- Display validation warnings/errors
- Handle truncation notifications
- Show effective manifest differences

### Phase 4: UI/UX Enhancements

#### 4.1 Class Information Display
- Add class information panel in JurySelection
- Show resource limits (max outcomes, panel size, iterations)
- Display supported providers and model count
- Add status indicators (active, deprecated, empty)

#### 4.2 Model Selection Interface
- Group models by provider
- Show model-specific information (context window, supported file types)
- Add model availability indicators
- Implement smart defaults based on class

#### 4.3 Error Handling & Feedback
- Toast notifications for class-related errors
- Graceful fallbacks for network issues
- Clear messaging for deprecated/empty classes
- Loading states during model fetching

### Phase 5: Validation & Testing

#### 5.1 Manifest Validation Integration
- Implement client-side pre-validation before submission
- Display validation results with clear explanations
- Handle truncation scenarios gracefully
- Show effective manifest preview

#### 5.2 Error Scenarios Testing
- Unknown class IDs
- Empty/deprecated classes
- Network failures
- Invalid model selections

## Implementation Order

### Sprint 1: Backend Foundation
1. Server-side classMap integration
2. New API endpoints
3. Enhanced contract validation

### Sprint 2: Frontend Services
1. ClassMapService implementation
2. ModelProviderService creation
3. Service integration testing

### Sprint 3: Core Component Updates
1. App.js state management updates
2. JurySelection component overhaul
3. Dynamic model loading implementation

### Sprint 4: Enhanced Features
1. Contract Management enhancements
2. Run Query validation integration
3. UI/UX improvements

### Sprint 5: Polish & Testing
1. Error handling refinements
2. Loading states and feedback
3. End-to-end testing
4. Documentation updates

## Technical Considerations

### Browser Compatibility
- Ensure classMap functions work in browser environment
- Handle any Node.js-specific dependencies
- Implement proper error boundaries

### Performance
- Cache class data to reduce API calls
- Implement intelligent re-fetching strategies
- Optimize model list rendering

### Backward Compatibility
- Maintain existing contract format
- Graceful degradation for old class IDs
- Default fallback behaviors

### Error Resilience
- Network failure handling
- Invalid class ID scenarios
- Server-side validation failures

## Success Metrics

1. **Dynamic Model Loading**: Models update automatically when contract/class changes
2. **Class Validation**: Invalid classes are caught and reported clearly
3. **User Experience**: Smooth transitions between different class capabilities
4. **Error Handling**: Graceful handling of all error scenarios
5. **Performance**: No noticeable delays in model loading/switching

## Future Enhancements

1. **Class Comparison**: Allow users to compare different classes
2. **Model Recommendations**: Suggest optimal models based on query type
3. **Usage Analytics**: Track class/model usage patterns
4. **Auto-Migration**: Suggest class upgrades when beneficial
5. **Advanced Filtering**: Filter models by capabilities (context window, file types)

## Files to Create/Modify

### New Files
- `client/src/services/classMapService.js`
- `client/src/services/modelProviderService.js`
- `server/routes/classRoutes.js` (optional, if separating from contract routes)

### Modified Files
- `server/server.js`
- `server/routes/contractRoutes.js`
- `client/src/App.js`
- `client/src/pages/JurySelection.js`
- `client/src/pages/ContractManagement.js`
- `client/src/pages/RunQuery.js`

## Dependencies

### Backend
- `@verdikta/common` (already installed) - for classMap functionality

### Frontend
- No new dependencies required
- Existing `@verdikta/common` version may need update to access classMap

## Risk Mitigation

1. **API Changes**: Implement versioned API endpoints
2. **Data Migration**: Ensure existing contracts work with new system
3. **Rollback Plan**: Feature flags for easy rollback if needed
4. **Testing**: Comprehensive testing of all class/model combinations
5. **Documentation**: Clear migration guide for users

---

*This plan provides a comprehensive roadmap for integrating ClassID → Model Pool mapping while maintaining system stability and user experience.*

