# Query Definition

The Query Definition page is where you formulate the question or scenario you want the AI Jury to evaluate. This is the foundation of your evaluation and determines what the AI models will analyze.

## Writing Your Query

### Query Text
Enter your question or scenario in the main text area. Be clear and specific about what you want evaluated.

**Good Examples:**
- "Should Company X acquire Company Y based on the provided financial data?"
- "Is the proposed marketing strategy likely to succeed given current market conditions?"
- "Does the evidence support the claim that Product A is superior to Product B?"

**Tips for Effective Queries:**
- Use clear, unambiguous language
- Provide sufficient context within the query itself
- Avoid leading questions that bias toward specific outcomes
- Reference supporting materials when relevant

## Defining Outcomes

### Default Outcomes
By default, queries have two outcomes: "True" and "False". This works well for yes/no questions.

### Custom Outcomes
You can customize outcomes to better fit your evaluation:

1. **Edit Existing Outcomes**: Click on any outcome field and type your preferred label
2. **Add More Outcomes**: Click **"+ Add Outcome"** to create additional options
3. **Remove Outcomes**: Click the **×** button next to any outcome (minimum 2 required)

**Example Custom Outcomes:**
- For product rankings: "Product A Best", "Product B Best", "Tie"
- For risk assessment: "Low Risk", "Medium Risk", "High Risk"
- For strategy evaluation: "Highly Recommended", "Somewhat Recommended", "Not Recommended"

## Supporting Data

### Upload Files

Add relevant documents, images, or data files to support your query.

**Supported File Types:**
- Documents (PDF, DOC, TXT)
- Images (JPG, PNG, GIF)
- Data files (CSV, JSON, XML)
- Archives (ZIP)

**How to Upload:**
1. Click **"Choose Files"** or drag files into the upload area
2. Select one or more files from your computer
3. Add descriptions to help the AI understand each file's relevance
4. Remove files using the **×** button if needed

**Best Practices:**
- Keep file sizes reasonable (under 10MB per file)
- Use descriptive filenames
- Add meaningful descriptions explaining each file's purpose
- Include only relevant materials to avoid confusion

### IPFS Content IDs (CIDs)

Reference external data stored on IPFS by providing Content IDs.

**Adding CIDs:**
1. Enter the IPFS CID in the text field
2. Click **"Add CID"**
3. Provide a descriptive name and description
4. Remove CIDs using the **×** button if needed

**When to Use CIDs:**
- Referencing large datasets stored on IPFS
- Linking to previously uploaded evaluation materials
- Including data that's already available on the decentralized web

### Reference URLs

Include links to online resources that provide additional context.

**Adding URLs:**
1. Enter the complete URL (including https://)
2. Click **"Add URL"**
3. Add a description explaining the link's relevance
4. URLs are automatically validated for proper format

**Effective URL Usage:**
- Link to authoritative sources
- Include recent, relevant information
- Avoid paywalled or restricted content
- Ensure links will remain accessible during evaluation

## Data Organization Tips

### Structure Your Supporting Data
- **Primary Sources**: Include original documents, data, or research
- **Context Materials**: Add background information to help AI understanding
- **Reference Materials**: Link to established facts, standards, or benchmarks

### Descriptions Matter
- Write clear, concise descriptions for all supporting materials
- Explain how each item relates to your query
- Help the AI understand the relevance and importance of each piece

### Quality Over Quantity
- Include only materials that directly support evaluation
- Avoid redundant or tangentially related content
- Focus on high-quality, reliable sources

## Navigation

- **Next**: Click **"Next: Jury Selection"** to proceed to AI model configuration
- **Validation**: The Next button is only enabled when you've entered query text

## Common Issues

### File Upload Problems
- **File too large**: Compress files or use IPFS for large datasets
- **Unsupported format**: Convert to supported formats or use alternative hosting

### URL Validation Errors
- **Invalid URL**: Ensure URL includes protocol (https://)
- **Broken links**: Verify URLs are accessible before adding

### Query Clarity
- **Vague questions**: Add specific criteria and context
- **Multiple questions**: Split complex queries into separate evaluations
- **Ambiguous outcomes**: Ensure outcomes are mutually exclusive and comprehensive 