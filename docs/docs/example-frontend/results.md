# Results

The Results page displays the outcomes of your AI jury evaluation, including quantitative results, detailed justifications, and reference information for future access.

## Results Overview

### Query Configuration Summary

The top section displays your evaluation setup:
- **Query Text**: The question that was evaluated
- **Outcomes**: Number of possible results
- **Iterations**: How many evaluation cycles were run
- **Jury Members**: Number of AI models that participated
- **Supporting Files**: Count of included reference materials

If your query used a pre-built package, this shows the package's configuration rather than your local settings.

### AI Jury Configuration Details

For package-based queries, you'll see detailed jury information:
- **Provider and Model**: Which AI services were used
- **Runs**: How many times each model evaluated the query
- **Weight**: Relative influence of each model (shown as percentage)

## Understanding Results

### Results Bar Chart

The bar chart visualizes the AI jury's conclusions:

#### Reading the Chart
- **X-axis**: Shows your defined outcome labels
- **Y-axis**: Likelihood values (0 to 1,000,000)
- **Bars**: Height represents the jury's confidence in each outcome
- **Colors**: Different colors distinguish between outcomes

#### Interpreting Values
- **1,000,000**: Maximum confidence (100%)
- **500,000**: Moderate confidence (50%)
- **0**: No confidence (0%)
- **Total**: All values sum to 1,000,000 (100%)

#### Percentage Calculation
Hover over bars to see percentages:
- Percentage = (Bar Value ÷ 1,000,000) × 100%

### Example Interpretations

**Scenario 1: Clear Decision**
```
Outcome A: 850,000 (85%)
Outcome B: 150,000 (15%)
```
Strong confidence favoring Outcome A

**Scenario 2: Close Call**
```
Outcome A: 520,000 (52%)
Outcome B: 480,000 (48%)
```
Slight preference for Outcome A, but close

**Scenario 3: Multiple Outcomes**
```
Outcome A: 100,000 (10%)
Outcome B: 600,000 (60%)
Outcome C: 300,000 (30%)
```
Strong preference for Outcome B, with Outcome C as secondary

## AI Jury Justification

### Understanding the Justification

The justification section contains the AI jury's reasoning:
- **Detailed Analysis**: Step-by-step evaluation process
- **Evidence Review**: How supporting materials influenced decisions
- **Consensus Building**: How different models reached agreement
- **Uncertainty Discussion**: Areas where models disagreed or were uncertain

### Justification Features

#### Pagination
- Long justifications are split into readable pages
- Navigate using page controls at the bottom
- Page numbers show current position

#### Content Types
Justifications may include:
- **Executive Summary**: High-level conclusions
- **Detailed Analysis**: In-depth reasoning
- **Evidence Citations**: References to your supporting materials
- **Model Perspectives**: Individual model viewpoints
- **Confidence Levels**: Certainty indicators for different aspects

#### Reading Tips
- **Start with Summary**: Look for conclusion sections first
- **Check Evidence Usage**: See how your supporting materials were used
- **Note Disagreements**: Areas where models differed indicate uncertainty
- **Consider Context**: Relate findings back to your original query

## Reference Information

### Content IDs (CIDs)

Two important CIDs are displayed:

#### Query Package CID
- **Purpose**: References your original query and configuration
- **Use Cases**: 
  - Share your query setup with others
  - Rerun the same evaluation later
  - Reference in documentation or reports
- **Access**: Click the link to view on IPFS

#### Result CID
- **Purpose**: References the evaluation results and justification
- **Use Cases**:
  - Share results with stakeholders
  - Reference in future analyses
  - Archive evaluation outcomes
- **Access**: Click the link to view raw results on IPFS

#### Copying CIDs
- Click the 📋 button next to any CID to copy it to clipboard
- Use copied CIDs in other applications or documentation
- CIDs are permanent references to specific content

### Evaluation Timestamp

When available, the timestamp shows:
- **Date and Time**: When the evaluation was completed
- **Time Zone**: Includes local time zone information
- **Precision**: Accurate to the second

## Viewing Past Results

### Looking Up Previous Evaluations

Use the "View Past Results" section to access historical data:

#### Finding Result CIDs
- Check your browser history for previous sessions
- Look in blockchain transaction records
- Reference saved documentation or notes
- Ask colleagues who may have the CID

#### Loading Process
1. Enter the Result CID in the text field
2. Click **"Load Results"**
3. Wait for the system to fetch and parse the data
4. Results will replace current display

#### What Gets Loaded
- **Outcome Distribution**: Bar chart with historical results
- **Justification**: Original AI jury reasoning
- **Configuration**: Query setup information
- **Timestamp**: When the evaluation occurred

### Managing Multiple Results

#### Comparing Evaluations
- Load different results in separate browser tabs
- Note differences in configurations and outcomes
- Look for patterns across similar queries

#### Result Organization
- Save important Result CIDs in external documentation
- Create naming conventions for different query types
- Maintain a log of evaluations for reference

## Taking Action on Results

### Next Steps Based on Outcomes

#### Clear, Confident Results
- **High Consensus**: Proceed with confidence in the decision
- **Document Rationale**: Save justification for future reference
- **Implement Decision**: Act on the AI jury's recommendation

#### Uncertain or Close Results
- **Gather More Data**: Add supporting materials and re-evaluate
- **Refine Query**: Clarify ambiguous aspects of your question
- **Increase Jury Size**: Add more AI models for additional perspectives
- **Multiple Iterations**: Run more evaluation cycles

#### Unexpected Results
- **Review Justification**: Understand the AI reasoning
- **Check Supporting Data**: Ensure materials were interpreted correctly
- **Consider Bias**: Look for potential model or data biases
- **Seek Second Opinion**: Run similar queries with different configurations

### Starting New Evaluations

#### New Query Button
Click **"New Query"** to:
- Clear current results
- Return to Query Definition page
- Start fresh with a clean configuration
- Keep current contract and wallet settings

#### Building on Previous Queries
- Use insights from current results to improve future queries
- Reference successful configurations for similar evaluations
- Learn from justifications to ask better questions

## Best Practices

### Result Interpretation
- **Consider Context**: Relate results back to your original decision needs
- **Read Justifications**: Don't rely solely on numerical outcomes
- **Note Confidence**: Pay attention to how certain the AI jury was
- **Check Evidence Usage**: Ensure your supporting materials were properly considered

### Documentation and Sharing
- **Save Important CIDs**: Keep records of significant evaluations
- **Document Context**: Note why you ran the evaluation and how you used results
- **Share Appropriately**: Consider what information is suitable for different audiences
- **Archive Results**: Maintain long-term access to important decisions

### Continuous Improvement
- **Learn from Patterns**: Notice what types of queries work best
- **Refine Techniques**: Improve how you structure queries and supporting data
- **Experiment with Configurations**: Try different jury setups for comparison
- **Build Expertise**: Develop skills in interpreting AI jury evaluations

## Troubleshooting

### Display Issues
- **Missing Chart**: Refresh page if bar chart doesn't load
- **Broken Links**: Check internet connection for IPFS access
- **Loading Errors**: Verify CIDs are correctly formatted

### Data Interpretation
- **Unexpected Results**: Review query clarity and supporting data quality
- **Missing Justification**: Check if evaluation completed successfully
- **Confusing Reasoning**: Consider if your query was ambiguous

### Access Problems
- **CID Not Found**: Verify the CID was copied correctly
- **Slow Loading**: IPFS access may be temporarily slow
- **Format Errors**: Ensure you're using Result CIDs, not Query Package CIDs for past results 