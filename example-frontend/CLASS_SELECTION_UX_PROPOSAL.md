# Class ID Selection UX Proposal

## 🎯 Problem Statement

Currently, Class ID is tightly coupled with contract address in a single dropdown. Users need:
1. **Flexibility**: One contract can serve multiple Class IDs
2. **Discoverability**: Browse available classes and their capabilities
3. **Clarity**: Understand what each class offers before selection
4. **Efficiency**: Quick switching between classes for the same contract

## 🎨 Proposed Solution: Two-Stage Selection

### **Stage 1: Contract Selection (Existing)**
- Keep current contract dropdown in header
- Focus purely on contract address selection
- Remove class ID coupling from this step

### **Stage 2: Class Selection (New Component)**
- **Location**: Prominent placement on each relevant page (Query Definition, Jury Selection)
- **Format**: Card-based class browser with rich information
- **Interaction**: Click to select, visual feedback for active class

## 📱 Detailed UX Design

### **Class Selector Component Layout**

```
┌─────────────────────────────────────────────────────────────┐
│ 🎯 Select AI Class                                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│ │Class 128 │  │Class 129 │  │Class 130 │  │Class XXX │     │
│ │ ACTIVE   │  │ ACTIVE   │  │ EMPTY    │  │DEPRECATED│     │
│ │──────────│  │──────────│  │──────────│  │──────────│     │
│ │OpenAI &  │  │Open-Source│  │Hyperbolic│  │Legacy    │     │
│ │Anthropic │  │Local      │  │API       │  │Models    │     │
│ │Core      │  │(Ollama)   │  │(Reserved)│  │          │     │
│ │          │  │           │  │          │  │          │     │
│ │Models: 3 │  │Models: 4  │  │Models: 0 │  │Models: 2 │     │
│ │Max: 5    │  │Max: 5     │  │Max: --   │  │Max: 3    │     │
│ │Runs: 2   │  │Runs: 2    │  │Runs: --  │  │Runs: 1   │     │
│ │Iter: 3   │  │Iter: 3    │  │Iter: --  │  │Iter: 2   │     │
│ │          │  │           │  │          │  │          │     │
│ │ ✓ SELECTED│  │          │  │ DISABLED │  │          │     │
│ └──────────┘  └──────────┘  └──────────┘  └──────────┘     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### **Card States & Visual Design**

#### **Active/Selected Class** ✅
- **Border**: Thick blue/purple border
- **Background**: Light blue/purple tint
- **Checkmark**: ✓ SELECTED badge
- **Shadow**: Elevated appearance

#### **Available Classes**
- **Border**: Light gray border
- **Background**: White/light background
- **Hover**: Subtle shadow + border color change
- **Cursor**: Pointer cursor

#### **Empty Classes** ⚠️
- **Border**: Dashed orange border
- **Background**: Light orange tint
- **Badge**: "EMPTY" warning badge
- **State**: Disabled (not clickable)
- **Tooltip**: "This class has no available models"

#### **Deprecated Classes** 🚫
- **Border**: Dashed red border
- **Background**: Light red tint
- **Badge**: "DEPRECATED" warning badge
- **State**: Clickable but with warning
- **Tooltip**: "This class is deprecated but still functional"

### **Information Hierarchy**

#### **Primary Info** (Large, Bold)
- Class ID number (e.g., "Class 128")
- Status badge (ACTIVE/EMPTY/DEPRECATED)

#### **Secondary Info** (Medium)
- Class name/description
- Brief capability summary

#### **Tertiary Info** (Small, Muted)
- Model count
- Key limits (Max Models, Max Runs, Max Iterations)

## 🔄 User Flow

### **Initial Load**
1. User selects contract from header dropdown
2. Class selector loads all available classes
3. Default class (128) is pre-selected
4. Page content updates to show class-specific information

### **Class Switching**
1. User clicks different class card
2. Visual feedback: Previous card deselects, new card highlights
3. Page content updates immediately (models, limits, etc.)
4. Smooth transition animations for better UX

### **Error Handling**
1. **Empty Classes**: Show disabled state with explanation
2. **Network Errors**: Show retry button and error message
3. **Loading States**: Skeleton cards while fetching data

## 📍 Placement Strategy

### **Query Definition Page**
- **Location**: After main heading, before query input
- **Purpose**: Set expectations for outcome limits
- **Emphasis**: Highlight Max Outcomes prominently

### **Jury Selection Page**
- **Location**: Replace current class info section
- **Purpose**: Show model availability and limits
- **Emphasis**: Highlight Max Models, Max Runs, Max Iterations

### **Responsive Design**
- **Desktop**: 4 cards per row
- **Tablet**: 2 cards per row
- **Mobile**: 1 card per row, stack vertically

## 🎛️ Advanced Features (Future)

### **Filtering & Sorting**
```
┌─────────────────────────────────────────┐
│ Filter: [All ▼] [ACTIVE ▼] [Provider ▼] │
│ Sort: [Class ID ▼] [Model Count ▼]      │
└─────────────────────────────────────────┘
```

### **Detailed View Modal**
- Click "ℹ️" icon on card for full class details
- Show complete model list, file type support, etc.
- Compare classes side-by-side

### **Favorites/Recents**
- Star frequently used classes
- Show recently used classes first
- Personal preferences persistence

## 🎨 Implementation Approach

### **Component Structure**
```
ClassSelector/
├── ClassSelector.js          # Main container component
├── ClassCard.js             # Individual class card
├── ClassCardSkeleton.js     # Loading state
└── ClassSelector.css        # Styling
```

### **State Management**
- **App.js**: `selectedClassId` (decoupled from contract)
- **ClassSelector**: Local state for loading, error handling
- **Automatic Updates**: When class changes, update all dependent data

### **API Integration**
- Use existing `/api/classes` endpoint
- Cache class data for performance
- Real-time updates when class information changes

## 🧪 User Testing Scenarios

### **Scenario 1: New User Discovery**
1. User lands on Query Definition page
2. Sees class selector with clear options
3. Hovers over cards to see tooltips
4. Clicks different classes to see how limits change
5. **Success Metric**: User understands class differences within 30 seconds

### **Scenario 2: Power User Efficiency**
1. Experienced user wants to switch from Class 128 to 129
2. Immediately recognizes current selection
3. Single click to switch classes
4. Page updates instantly with new models
5. **Success Metric**: Class switching takes < 3 seconds

### **Scenario 3: Error Recovery**
1. User selects empty class (130)
2. Clear visual feedback about unavailability
3. Helpful tooltip explains the situation
4. Easy to switch to available alternative
5. **Success Metric**: User recovers without confusion

## 🎯 Success Metrics

### **Usability**
- **Discovery Time**: < 30 seconds to understand class differences
- **Selection Time**: < 3 seconds to switch classes
- **Error Rate**: < 5% of users select unavailable classes

### **User Satisfaction**
- **Clarity**: Users understand what each class offers
- **Control**: Users feel empowered to explore options
- **Efficiency**: Switching classes feels fast and responsive

### **Technical Performance**
- **Load Time**: < 500ms to display class cards
- **Update Time**: < 200ms to switch between classes
- **Accessibility**: Full keyboard navigation support

## 🚀 Implementation Priority

### **Phase 1: Core Functionality** (High Priority)
- Basic card layout with essential information
- Click to select functionality
- Integration with existing class data
- Responsive design for mobile/desktop

### **Phase 2: Enhanced UX** (Medium Priority)
- Smooth animations and transitions
- Better loading states and error handling
- Improved visual design and iconography
- Accessibility improvements

### **Phase 3: Advanced Features** (Low Priority)
- Filtering and sorting options
- Detailed view modal
- Favorites/recents functionality
- Class comparison tools

---

This design prioritizes **discoverability**, **clarity**, and **efficiency** while maintaining the existing functionality. Users can quickly understand their options and make informed decisions about which class best fits their needs.

