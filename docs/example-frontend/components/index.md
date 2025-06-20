# Components

This section documents the React components used in the Example Frontend application.

## Component Overview

The application consists of several key components organized into logical groups:

### Core Components

- **Header** - Main navigation header with wallet connection and contract selection
- **App** - Root application component that manages routing and state

### Page Components

- **Contract Management** - Interface for managing smart contracts ([see user guide](../contract-management.md))
- **Jury Selection** - AI model configuration interface ([see user guide](../jury-selection.md))
- **Query Definition** - Query input and configuration interface ([see user guide](../query-definition.md))
- **Results** - Results display and visualization ([see user guide](../results.md))
- **Run Query** - Query execution interface ([see user guide](../run-query.md))

### Utility Components

- **Paginated Justification** - Component for displaying paginated AI justifications
- **File Upload** - Reusable file upload components
- **Chart Visualization** - Result visualization components

## Component Architecture

Components follow React best practices with clear separation of concerns and reusable design patterns. The application uses:

- React functional components with hooks
- Ethers.js for blockchain interaction
- Chart.js for data visualization
- React Router for navigation

For detailed information about each page's functionality, see the corresponding user guide documentation. 