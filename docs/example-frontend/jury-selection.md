# Jury Selection

The Jury Selection page allows you to configure the AI models that will evaluate your query. You can set up multiple AI providers, adjust evaluation parameters, and fine-tune how the jury reaches its decision.

## Overview

This page displays your query's possible outcomes and lets you configure:
- **Arbiter jury size** - How many arbiters the aggregator draws for each request, and the round timeout
- **Number of iterations** - How many times the evaluation process runs
- **Jury composition** - Which AI models participate and their roles
- **Model parameters** - Runs per model and relative weights

## Arbiter Jury Size

Every request carries its own jury, the four numbers K/M/N/P and a timeout: K arbiters are drawn, M of those that commit are promoted to reveal, the first N reveals are counted, and the result is the average of the tightest cluster of P. The timeout is how long the round may run after the draw. One aggregator serves every size; the setting is kept in your browser.

| Setting | K / M / N / P | Timeout | Beacons |
|---|---|---|---|
| Small (default) | 6 / 5 / 4 / 3 | 300 s | off |
| Medium | 8 / 5 / 4 / 3 | 300 s | off |
| Large | 21 / 16 / 13 / 10 | 300 s | off |
| Jumbo | 50 / 38 / 27 / 17 | 600 s | on |

These are the bounty program's class presets. A bigger jury is harder to sway but costs more: the prepayment is max(fee, floor) × (K + 3 × P [+ 2 beacons]) plus the draw and promote rewards, and the draw uses more gas. Jumbo also runs a beacon stage before the draw (one more `drawJury` from your wallet). If fewer than K arbiters are eligible, the jury repeats arbiters; only a class with none fails the draw. The aggregator refuses a jury above its `maxJury()` (50 by default) or a timeout outside `tPlus()` < timeout ≤ `maxTimeout()` (155 s and 3,600 s by default) or above one day (86,400 s, whatever `maxTimeout()` says) with `BadJury`.

With beacons, the draw is seeded not only by a block hash but also by fresh values from 2 of 4 arbiters picked as beacons (each answers a health call with its next hash-chain value). The first `drawJury` starts this stage and the second draws once 2 values are in (the stage waits at most 120 seconds). If fewer than 2 arrive within 120 seconds the round ends without a result and most of the prepayment goes to the arbiter pool (see [Run Query](run-query.md#5-if-the-round-misses-its-deadline)).

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
The providers and models offered are not fixed: they are the model pool of the
selected contract's class, read from the class map in `@verdikta/common`. A
model that is not in the class's pool is not offered, and a juror naming one is
switched to the first model the class lists for its provider.

The pool changes between `@verdikta/common` releases, so the page is the
reference, not this document. For class 128 ("OpenAI & Anthropic Core"),
release 1.8.0 lists:

- **OpenAI**: `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-5.6-luna`,
  `gpt-5.4-2026-03-05`, `gpt-5.2-2025-12-11`
- **Anthropic**: `claude-sonnet-5`, `claude-sonnet-4-6`,
  `claude-haiku-4-5-20251001`

`gpt-5.2-2025-12-11` and `claude-haiku-4-5-20251001` are in class 128 in every
release from 1.6.0 to 1.8.0.

Other classes offer other pools (class 129, for example, lists open-source
models served by Ollama). Use only models the class lists: an arbiter answers a
request only when every juror of the jury answered, so one retired or unlisted
model leaves the whole request without a verdict. Older models such as `gpt-4o`
and `claude-3-5-sonnet-20241022` are no longer in any pool.

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
- Use one high-quality model (e.g., `gpt-5.2-2025-12-11`)
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
- Consider smaller models for cost-sensitive applications

## Example Configurations

### Financial Analysis Query
```
Model 1: OpenAI gpt-5.2-2025-12-11 (Weight: 0.6, Runs: 2)
Model 2: Anthropic claude-haiku-4-5-20251001 (Weight: 0.4, Runs: 1)
Iterations: 2
```

### Creative Content Evaluation
```
Model 1: OpenAI gpt-5.2-2025-12-11 (Weight: 0.4, Runs: 1)
Model 2: Anthropic claude-haiku-4-5-20251001 (Weight: 0.6, Runs: 1)
Iterations: 1
```

### Quick Fact Check
```
Model 1: OpenAI gpt-5.2-2025-12-11 (Weight: 1.0, Runs: 1)
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
- Single OpenAI `gpt-5.2-2025-12-11` model
- 1 run, weight 1.0
- 1 iteration

### For Advanced Users
Experiment with:
- Multiple providers for diverse perspectives
- Different weight distributions based on query type
- Higher iterations for critical decisions
- Specialized models for domain-specific queries 