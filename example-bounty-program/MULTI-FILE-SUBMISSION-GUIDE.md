# Multi-File Submission Enhancement Guide

**Date:** October 14, 2025  
**Feature:** Custom Submission Narratives & Multiple File Uploads  
**Status:** ✅ Complete

## Overview

The submission workflow has been enhanced to support:
1. **Custom submission narratives** (up to 200 words) that hunters can use to explain nuances about their work
2. **Multiple file uploads** (up to 10 files) with individual descriptions for each file
3. **Full compliance** with the [Verdikta Manifest Specification](https://docs.verdikta.com/verdikta-common/MANIFEST_SPECIFICATION/)

## What Changed

### Backend Updates

#### 1. Archive Generator (`server/utils/archiveGenerator.js`)

**Updated `createHunterSubmissionCIDArchive()` function:**

```javascript
// OLD: Single file
createHunterSubmissionCIDArchive({
  workProductPath: string,
  workProductName: string,
  workProductType: string
})

// NEW: Multiple files with descriptions and narrative
createHunterSubmissionCIDArchive({
  workProducts: [
    {
      path: string,
      name: string,
      type: string,
      description: string  // NEW: Per-file description
    }
  ],
  submissionNarrative: string  // NEW: Custom narrative (optional)
})
```

**Generated manifest.json now includes:**
```json
{
  "version": "1.0",
  "name": "submittedWork",
  "primary": {
    "filename": "primary_query.json"
  },
  "additional": [
    {
      "name": "submitted-work-1",
      "type": "text/plain",
      "filename": "submission/file1.txt",
      "description": "Main document with research findings"
    },
    {
      "name": "submitted-work-2",
      "type": "image/jpeg",
      "filename": "submission/chart.jpg",
      "description": "Supporting chart showing data trends"
    }
  ]
}
```

**Generated primary_query.json uses custom narrative:**
```json
{
  "query": "Thank you for the opportunity to submit this work. I've included two files: the main research document and a supporting chart. The chart illustrates the key trends discussed in section 3 of the document. Please note that the data was collected over a 6-month period ending September 2025.",
  "references": ["submitted-work-1", "submitted-work-2"]
}
```

#### 2. Job Routes (`server/routes/jobRoutes.js`)

**Updated submission endpoint:**
- Changed from `upload.single('file')` to `upload.array('files', 10)`
- Accepts `submissionNarrative` form field (validated to 200 words max)
- Accepts `fileDescriptions` JSON object mapping filenames to descriptions
- Validates narrative word count on server side
- Returns enhanced submission data including file count and descriptions

**Request Format:**
```
POST /api/jobs/:jobId/submit
Content-Type: multipart/form-data

files: [File, File, ...]  // Array of files
hunter: string            // Wallet address
submissionNarrative: string  // Optional, max 200 words
fileDescriptions: JSON    // { "filename1.txt": "description", ... }
```

**Response includes:**
```json
{
  "success": true,
  "submission": {
    "hunter": "0x...",
    "hunterCid": "QmXXX...",
    "updatedPrimaryCid": "QmYYY...",
    "fileCount": 2,
    "files": [
      {
        "filename": "file1.txt",
        "size": 1024,
        "description": "Main document"
      }
    ],
    "totalSize": 2048
  },
  "testingInfo": { ... }
}
```

### Frontend Updates

#### 1. SubmitWork Page (`client/src/pages/SubmitWork.jsx`)

**New Features:**

**A. Submission Narrative Section**
- Textarea for custom message (defaults to standard text)
- Real-time word counter (0-200 words)
- Prevents exceeding 200-word limit
- Preserves user input across edits

**B. Multiple File Upload**
- Support for adding multiple files (up to 10)
- Drag-and-drop compatible file input
- File validation (type, size) for each file
- Remove individual files before submission
- Display total size of all files

**C. File Descriptions**
- Each file gets its own description field
- Descriptions auto-populated with filename
- Editable before submission
- Max 200 characters per description
- Included in manifest for AI context

**D. Enhanced CID Dialog**
- Shows file count in success message
- Lists all submitted files with sizes and descriptions
- Displays total submission size
- Includes explanatory notes about what's in each CID
- Links to Verdikta Manifest Specification

**UI Components:**
```jsx
<div className="form-section">
  <h2>Submission Narrative</h2>
  <textarea>
    {submissionNarrative} (200 words max)
  </textarea>
</div>

<div className="form-section">
  <h2>Upload Files</h2>
  <input type="file" multiple />
  
  <div className="files-list">
    {files.map(file => (
      <div className="file-item">
        <div className="file-header">
          <FileInfo />
          <RemoveButton />
        </div>
        <div className="file-description">
          <input value={description} />
        </div>
      </div>
    ))}
  </div>
</div>
```

#### 2. API Service (`client/src/services/api.js`)

**New method:**
```javascript
async submitWorkMultiple(jobId, formData) {
  // formData contains files, hunter, narrative, and descriptions
  const response = await api.post(`/api/jobs/${jobId}/submit`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  });
  return response.data;
}
```

#### 3. Styling (`client/src/pages/SubmitWork.css`)

**New CSS classes:**
- `.word-count` - Displays word counter
- `.files-list` - Container for file items
- `.file-item` - Individual file card
- `.file-header` - File name, size, and remove button
- `.file-description` - Description input field
- `.files-summary` - Total size display
- `.btn-remove` - Remove file button
- `.submitted-file-info` - File info in CID dialog
- `.cid-note` - Explanatory notes in dialog

## Testing Instructions

### 1. Test Custom Narrative

1. Go to a job and click "Submit Work"
2. Edit the narrative textarea
3. Add a custom message (try going over 200 words to see limit)
4. Verify word counter updates in real-time
5. Submit and verify narrative is in the CID dialog

### 2. Test Single File Submission

1. Add one file
2. Verify default description is set
3. Edit the description
4. Submit and check the result

### 3. Test Multiple Files

1. Add multiple files (try 2-3 files)
2. Verify each gets its own description field
3. Edit descriptions for each file
4. Remove one file and verify it's gone
5. Check total size calculation
6. Submit and verify all files are listed in CID dialog

### 4. Test File Validation

1. Try uploading a file > 20 MB (should reject)
2. Try uploading invalid file type (should reject)
3. Try uploading 11 files (should limit to 10)

### 5. Verify Manifest Structure

After submission, you can inspect the generated archives:

```bash
# Download and extract the Hunter CID archive
ipfs get <HUNTER_CID>
unzip <archive>.zip

# Check manifest.json
cat manifest.json
# Should show all files in "additional" array with descriptions

# Check primary_query.json  
cat primary_query.json
# Should show your custom narrative in "query" field
```

## Example Use Cases

### Use Case 1: Technical Documentation

**Narrative:**
> "I've prepared comprehensive documentation for the API. The main document covers all endpoints, while the examples file contains working code samples. The architecture diagram shows how the components interact."

**Files:**
- `api-documentation.md` - "Complete API reference with all endpoints and parameters"
- `code-examples.js` - "Working code examples for common use cases"
- `architecture.png` - "System architecture diagram"

### Use Case 2: Research Submission

**Narrative:**
> "This research analyzes market trends over Q3 2025. The data spreadsheet contains raw data from multiple sources, validated and cleaned. The analysis document presents findings with statistical backing. Charts provide visual representation of key trends."

**Files:**
- `market-data.xlsx` - "Raw data from 15 sources, collected Jun-Sep 2025"
- `analysis.pdf` - "Statistical analysis with methodology and findings"
- `trend-chart.jpg` - "Visualization of primary market trends"
- `regional-breakdown.png` - "Geographic distribution of market activity"

### Use Case 3: Design Portfolio

**Narrative:**
> "Design package for the mobile app redesign. Includes high-fidelity mockups for all main screens, the complete design system documentation, and interactive prototype link. All designs follow Material Design 3 guidelines."

**Files:**
- `app-mockups.fig` - "Figma file with all screen designs"
- `design-system.pdf` - "Complete design system documentation"
- `prototype-link.txt` - "Link to interactive Figma prototype"
- `user-flow.png` - "User journey and flow diagram"

## Manifest Specification Compliance

The implementation follows the [Verdikta Manifest Specification](https://docs.verdikta.com/verdikta-common/MANIFEST_SPECIFICATION/#complete-manifest-structure) for the `additional` array:

```json
"additional": [
  {
    "name": "unique-reference-name",
    "type": "text/plain",
    "filename": "submission/file.txt",
    "description": "Human-readable description"
  }
]
```

**Key Points:**
- ✅ `name` is unique for each file (submitted-work-1, submitted-work-2, etc.)
- ✅ `type` uses standard MIME types
- ✅ `filename` includes correct path (submission/...)
- ✅ `description` field is included per specification
- ✅ All files are referenced in primary_query.json `references` array

## Benefits

### For Hunters

1. **Better Context**: Explain nuances that help AI understand your work
2. **Multiple Files**: Submit complete work products with supporting materials
3. **Clear Documentation**: Each file can be described for AI context
4. **Flexibility**: Choose to use default narrative or customize it

### For AI Evaluation

1. **Rich Context**: Custom narratives provide important context
2. **File Purpose**: Descriptions help AI understand each file's role
3. **Better Evaluation**: More context leads to more accurate evaluations
4. **Structured Data**: Manifest format ensures consistent processing

### For the System

1. **Spec Compliant**: Follows official Verdikta manifest specification
2. **Scalable**: Supports 1-10 files without complexity
3. **Maintainable**: Clean separation of concerns
4. **Testable**: Easy to verify with example-frontend

## Migration Notes

### For Existing Code

The old single-file API still works:
```javascript
// Old way (still supported)
apiService.submitWork(jobId, file, hunter);

// New way (recommended)
const formData = new FormData();
formData.append('files', file);
formData.append('hunter', hunter);
formData.append('submissionNarrative', narrative);
apiService.submitWorkMultiple(jobId, formData);
```

### For Smart Contracts

When smart contracts are integrated:
- The archive generation logic remains the same
- Contract receives the same CID structure
- On-chain storage only needs CIDs, not file details
- File descriptions are in IPFS, not on-chain

## Technical Details

### Word Count Validation

**Frontend:**
```javascript
const wordCount = text.trim().split(/\s+/).filter(w => w.length > 0).length;
if (wordCount > 200) {
  // Prevent input
}
```

**Backend:**
```javascript
const wordCount = submissionNarrative.trim().split(/\s+/).length;
if (wordCount > 200) {
  return res.status(400).json({
    error: 'Narrative must be 200 words or less'
  });
}
```

### Reference Naming

Files are named sequentially:
- Single file: `submitted-work`
- Multiple files: `submitted-work-1`, `submitted-work-2`, etc.

This ensures unique names in the manifest's `additional` array.

### File Organization

All files are stored in the `submission/` directory within the archive:
```
hunter-archive.zip
├── manifest.json
├── primary_query.json
└── submission/
    ├── file1.txt
    ├── file2.pdf
    └── chart.jpg
```

## Troubleshooting

### Issue: Word counter doesn't update
- Check that `handleNarrativeChange` is connected to textarea
- Verify `getWordCount()` function is correct

### Issue: Files not uploading
- Check that input has `multiple` attribute
- Verify FormData is being created correctly
- Check network tab for actual request

### Issue: Descriptions not showing in CID
- Verify `fileDescriptions` is JSON stringified before sending
- Check server logs for parsing errors
- Ensure description field is in manifest.json

### Issue: Validation errors
- Word count: Check regex for word splitting
- File size: Verify MAX_FILE_SIZE constant
- File type: Check MIME type validation

## Future Enhancements

Possible future improvements:
- [ ] Rich text editor for narrative
- [ ] File preview before upload
- [ ] Drag-and-drop file upload
- [ ] Bulk file description editing
- [ ] Template narratives for common submissions
- [ ] Character count for descriptions
- [ ] File type icons in UI
- [ ] Progress bar for large uploads

## References

- [Verdikta Manifest Specification](https://docs.verdikta.com/verdikta-common/MANIFEST_SPECIFICATION/)
- [Blog Post Test Example](/verdikta-arbiter/external-adapter/test-artifacts/blog-post-test/)
- [IMPLEMENTATION-SUMMARY.md](IMPLEMENTATION-SUMMARY.md)
- [TESTING-GUIDE.md](TESTING-GUIDE.md)

