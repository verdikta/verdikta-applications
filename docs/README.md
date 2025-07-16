# Documentation Structure

This folder contains the documentation for all applications in the verdikta-applications repository.

## Overview

The documentation is structured to work seamlessly with MkDocs and the monorepo plugin, allowing it to be integrated into the main verdikta-docs repository as a git submodule.

## Structure

```
docs/
├── mkdocs.yml              # Main configuration for applications documentation
├── index.md                # Main documentation homepage
├── README.md              # This file
└── example-frontend/       # Example Frontend application documentation
    ├── mkdocs.yml         # Local configuration for this application
    ├── index.md           # Application homepage
    ├── components/        # Component documentation
    │   └── index.md
    └── development/       # Development guides
        └── index.md
```

## Integration with verdikta-docs

This documentation is designed to be pulled into the main verdikta-docs repository as a git submodule. The structure supports:

- **Monorepo Plugin**: The main mkdocs.yml includes the monorepo plugin configuration
- **Modular Documentation**: Each application maintains its own documentation structure
- **Consistent Navigation**: All applications follow the same documentation patterns

## Local Development

To work with this documentation locally:

1. Install MkDocs and required plugins:
   ```bash
   pip install mkdocs mkdocs-material mkdocs-monorepo-plugin
   ```

2. Navigate to the docs folder:
   ```bash
   cd docs
   ```

3. Start the development server:
   ```bash
   mkdocs serve
   ```

## Adding New Applications

When adding documentation for new applications:

1. Create a new folder under `docs/` with the application name
2. Add the application's documentation structure
3. Update the main `docs/mkdocs.yml` navigation to include the new application
4. Follow the same patterns established by the example-frontend documentation

## Deployment

This documentation will be deployed as part of the main verdikta-docs site at docs.verdikta.org using Vercel. 