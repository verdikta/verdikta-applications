# AI Jury Query Package Manifest Format

## Overview
Each archive of information (using 7z, zip, or tar+gzip) must contain a manifest file named `manifest.json`. This document describes the format and structure of this manifest file.

## Manifest Structure

### Key Components
1. **version** (required)
   - Starts at and defaults to "1.0"
   - Allows for future format upgrades

2. **primary** (required)
   - Describes the primary file using ONE of:
     - `filename`: Name of JSON file located in the archive OR 
     - `hash`: CID of externally hosted file

3. **additional** (optional)
   - List of additional files referenced in the primary document
   - Each file contains:
     - `name`: Unique identifier for the file
     - `type`: Format descriptor
     - Either `filename` or `hash`
     - Optionally, `description`

4. **support** (optional)
   - List of hashes for supporting archives
   - Each entry contains:
     - `hash`: CID of supporting archive

5. **juryParameters** (required)
   - `NUMBER_OF_OUTCOMES`: Number of possible outcomes
   - `AI_NODES`: Array of AI jury members
     - Each node specifies:
       - `AI_MODEL`
       - `AI_PROVIDER`
       - `NO_COUNTS`
       - `WEIGHT`
   - `ITERATIONS`: Number of jury deliberation iterations

### Supported File Types
- Text: UTF8, UTF16
- Formatted: CSV, HTML
- Images: GIF, JPEG
- Audio: MP3, OGG
- Video: AV1, WEBM

## Primary File Format
The primary file is a JSON document with the following structure:

• "query": The AI evaluation prompt or question  
• "references": An array of identifiers for files in the "additional" section

Example primary file content in primary_query.json:
```json
{
  "query": "How many red circles are in this image?  Possible answers are 0,1,2,3,4,5,6,7,8,9",
  "references": [
    "supportingFile1"
  ]
}
```

Subsequent manifest.json:
```json
{
  "version": "1.0",
  "primary": {
    "filename": "primary_query.json"
  },
  "juryParameters": {
    "NUMBER_OF_OUTCOMES": 10,
    "AI_NODES": [
      {
        "AI_MODEL": "gpt-4o",
        "AI_PROVIDER": "OpenAI",
        "NO_COUNTS": 1,
        "WEIGHT": 1
      }
    ],
    "ITERATIONS": 1
  },
  "additional": [
    {
      "name": "supportingFile1",
      "type": "image/jpeg",
      "filename": "red-circle-image.jpg",
      "description": ""
    }
  ]
}
```

Another example primary file:
```json
{
  "query": "The images are primary focussed on 1) Sheep, or 2) Humans.  You can only pick one. ",
  "references": [
    "supportingFile1",
    "supportingFile2",
    "supportingFile3",
    "supportingFile4"
  ]
}
```

With the following manifest.json:
```json
{
  "version": "1.0",
  "primary": {
    "filename": "primary_query.json"
  },
  "juryParameters": {
    "NUMBER_OF_OUTCOMES": 2,
    "AI_NODES": [
      {
        "AI_MODEL": "gpt-4o",
        "AI_PROVIDER": "OpenAI",
        "NO_COUNTS": 1,
        "WEIGHT": 0.5
      },
      {
        "AI_MODEL": "claude-3-5-sonnet-20241022",
        "AI_PROVIDER": "Anthropic",
        "NO_COUNTS": 1,
        "WEIGHT": 0.5
      }
    ],
    "ITERATIONS": 1
  },
  "additional": [
    {
      "name": "supportingFile1",
      "type": "image/jpeg",
      "filename": "young-woman-with-dog.jpg",
      "description": ""
    },
    {
      "name": "supportingFile2",
      "type": "image/jpeg",
      "filename": "farmer-with-sheep-and-dog.jpg",
      "description": ""
    },
    {
      "name": "supportingFile3",
      "type": "image/jpeg",
      "filename": "crowd.jpg",
      "description": ""
    },
    {
      "name": "supportingFile4",
      "type": "image/jpeg",
      "filename": "sheep.jpg",
      "description": ""
    }
  ]
}
```

## Implementation Notes

### File References
- The primary file is always JSON with a "query" field and an optional "references" array.  
- References to additional files must match the `name` field in the manifest.  
- External files can be referenced using `hash`.

### Version Control
- Always set the version field, starting with "1.0".
- Future revisions may introduce breaking changes.