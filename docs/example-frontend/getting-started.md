# Getting Started

Welcome to the AI Jury System! This guide will walk you through setting up and using the application to create and run AI-powered evaluations.

## Prerequisites

Before you begin, make sure you have:

- **Web Browser**: A modern web browser with JavaScript enabled
- **MetaMask Wallet**: Browser extension installed and configured
- **Network**: Access to Base Sepolia testnet
- **LINK Tokens**: For paying AI jury evaluation fees

## Initial Setup

### 1. Connect Your Wallet

1. Click the **"Connect Wallet"** button in the top-right corner
2. MetaMask will prompt you to connect your account
3. Approve the connection request
4. Your wallet address will appear, showing you're connected

### 2. Select a Contract

- Use the contract dropdown in the header to select an AI Jury contract
- If no contracts are available, click **"Manage Contracts"** to add one
- You can refresh the contract list using the refresh button (↻)

## Basic Workflow

The AI Jury System follows a simple 4-step process:

1. **[Define Query](query-definition.md)** - Enter your question and supporting data
2. **[Jury Selection](jury-selection.md)** - Configure AI models to evaluate your query
3. **[Run Query](run-query.md)** - Execute the evaluation on the blockchain
4. **[View Results](results.md)** - Review outcomes and justifications

## Quick Start Example

Here's a simple example to get you started:

### Step 1: Define Your Query
- Navigate to **"Define Query"**
- Enter: "Is the sky blue during a clear day?"
- Keep default outcomes: "True" and "False"
- Click **"Next: Jury Selection"**

### Step 2: Configure the Jury
- The default jury configuration (OpenAI GPT-4o) works well for testing
- Click **"Next: Run Query"**

### Step 3: Run the Query
- Select **"Use Current Configuration"**
- Click **"Run Query"**
- Approve the transaction in MetaMask
- Wait for the evaluation to complete

### Step 4: View Results
- Review the outcome distribution in the bar chart
- Read the AI jury's justification
- Note the result CID for future reference

## Navigation

Use the navigation tabs in the header to move between sections:
- **Define Query**: Create and configure your evaluation
- **Jury Selection**: Set up AI models and parameters
- **Run**: Execute the evaluation
- **Results**: View outcomes and justifications

## Next Steps

- Learn more about [defining effective queries](query-definition.md)
- Explore [advanced jury configurations](jury-selection.md)
- Understand [different execution methods](run-query.md)
- Review [interpreting results](results.md) 