# Jury Selection

The Jury Selection page allows you to configure the AI models that will evaluate your query. You can set up multiple AI providers, adjust evaluation parameters, and fine-tune how the jury reaches its decision.

## Overview

This page displays your query's possible outcomes and lets you configure:
- **Number of iterations** - How many times the evaluation process runs
- **Jury composition** - Which AI models participate and their roles
- **Model parameters** - Runs per model and relative weights

## Number of Iterations

### What are Iterations?
An iteration is a complete evaluation cycle where all jury members assess your query. Multiple iterations can provide more robust results by averaging across several independent evaluations.

### Setting Iterations
- Use the **+** and **-** buttons to adjust the count
- Minimum: 1 iteration
- Higher iterations increase evaluation cost but may improve reliability
- For most queries, 1-3 iterations provide good results

**When to Use Multiple Iterations:**
- Complex queries with subjective elements
- High-stakes decisions requiring extra confidence
- Queries where AI models might have variable responses

## AI Jury Configuration

### Jury Members

Each jury member represents an AI model that will independently evaluate your query.

#### Provider Selection
Choose from available AI providers:

- **OpenAI**: GPT models known for strong reasoning capabilities
  - `gpt-3.5-turbo`: Fast, cost-effective for simpler queries
  - `gpt-4`: More advanced reasoning for complex evaluations
  - `gpt-4o`: Latest model with optimized performance

- **Anthropic**: Claude models with strong analytical capabilities
  - `claude-2.1`: Balanced performance for general use
  - `claude-3-sonnet-20240229`: Enhanced reasoning capabilities
  - `claude-3-5-sonnet-20241022`: Latest with improved analysis

- **Open-source**: Community models for specialized use cases
  - `llava`: Vision-language model for image analysis
  - `llama-3.1`: Strong general-purpose reasoning
  - `llama-3.2`: Improved efficiency and capability
  - `phi3`: Efficient model for lightweight evaluations

#### Model Configuration

**Runs**: Number of times each model evaluates the query
- More runs can reduce variability in model responses
- Typical range: 1-5 runs per model
- Consider cost vs. confidence trade-offs

**Weight**: Relative importance of this model's opinion (0.0-1.0)
- 1.0 = Full weight (default)
- 0.5 = Half weight compared to other models
- Use different weights to emphasize certain models' expertise
- Total weights are automatically normalized

### Managing Jury Members

#### Adding Models
1. Click **"Add Another AI Model"**
2. Configure the new model's provider, model, runs, and weight
3. Each model gets a unique configuration

#### Removing Models
1. Click the **×** button next to any jury member
2. At least one jury member must remain
3. Removing models reduces evaluation cost

#### Editing Configuration
- Change any parameter by clicking on dropdown menus or input fields
- Provider changes automatically update available models
- All changes are saved automatically

## Best Practices

### Jury Composition Strategies

#### Single Model (Simple Queries)
- Use one high-quality model (e.g., GPT-4o)
- Appropriate for straightforward factual questions
- Lowest cost, fastest execution

#### Multi-Model Ensemble (Complex Queries)
- Combine 2-4 different models
- Mix providers for diverse perspectives
- Use equal weights unless you have specific expertise requirements

#### Specialized Configurations
- **Technical queries**: Weight models known for technical accuracy higher
- **Creative evaluations**: Include diverse models with varying approaches
- **Fact-checking**: Use models with strong factual knowledge

### Parameter Optimization

#### Runs Configuration
- **1 run**: Standard for most queries
- **3-5 runs**: When model consistency is important
- **Higher runs**: Diminishing returns, increased cost

#### Weight Distribution
- **Equal weights**: Default approach for balanced evaluation
- **Expert weighting**: Higher weights for models with relevant specialization
- **Confidence weighting**: Higher weights for more reliable models

### Cost Considerations

Each jury member incurs evaluation costs based on:
- **Model pricing**: Different providers have different rates
- **Number of runs**: Cost scales linearly with runs
- **Query complexity**: Longer queries with more supporting data cost more

**Cost Optimization Tips:**
- Start with single models for testing
- Use iterations sparingly until you understand your needs
- Consider open-source models for cost-sensitive applications

## Example Configurations

### Financial Analysis Query
```
Model 1: OpenAI GPT-4 (Weight: 0.6, Runs: 2)
Model 2: Anthropic Claude-3-Sonnet (Weight: 0.4, Runs: 1)
Iterations: 2
```

### Creative Content Evaluation
```
Model 1: OpenAI GPT-4o (Weight: 0.4, Runs: 1)
Model 2: Anthropic Claude-3.5-Sonnet (Weight: 0.4, Runs: 1)
Model 3: Open-source Llama-3.1 (Weight: 0.2, Runs: 1)
Iterations: 1
```

### Quick Fact Check
```
Model 1: OpenAI GPT-4o (Weight: 1.0, Runs: 1)
Iterations: 1
```

## Navigation

- **Back**: Return to Query Definition to modify your query or supporting data
- **Next: Run Query**: Proceed to execution (only enabled when at least one jury member is configured)

## Tooltips and Help

Hover over the **ⓘ** icons next to each field for detailed explanations:
- **Provider**: Information about AI service providers
- **Model**: Details about specific AI models
- **Runs**: How multiple runs affect evaluation
- **Weight**: How model weights influence final results
- **Iterations**: How iterations improve result reliability

## Common Configurations

### For Beginners
Start with the default configuration:
- Single OpenAI GPT-4o model
- 1 run, weight 1.0
- 1 iteration

### For Advanced Users
Experiment with:
- Multiple providers for diverse perspectives
- Different weight distributions based on query type
- Higher iterations for critical decisions
- Specialized models for domain-specific queries 