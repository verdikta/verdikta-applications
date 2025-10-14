# Cursor Rules Documentation

This directory contains Cursor AI rules that help guide development in the Verdikta Applications monorepo.

## Rules Overview

### 1. General Development Rules (`.cursorrules`)
**Type:** Always applied  
**Scope:** Entire project

General principles, code quality standards, and development workflow guidelines that apply to all work in the repository.

**Key Topics:**
- Project structure overview
- Code quality principles
- Environment awareness
- Testing requirements
- Documentation standards

### 2. Bounty Program Architecture (`bounty-program-architecture.mdc`)
**Type:** Context-based (applies to example-bounty-program/**)  
**Scope:** Bounty program implementation

Comprehensive guide to the bounty program's architecture, patterns, and workflows.

**Key Topics:**
- Multi-CID architecture (Primary + Hunter archives)
- Threshold separation pattern
- Archive generation workflow
- Job creation and submission flows
- Smart contract integration path
- Testing patterns

**When to Reference:**
- Working on job creation/submission
- Debugging archive generation
- Understanding the multi-CID workflow
- Preparing for smart contract integration

### 3. API Conventions (`api-conventions.mdc`)
**Type:** Context-based (applies to **/server/**, **/routes/**)  
**Scope:** Backend API development

Standards for API design, request/response formats, validation, and error handling.

**Key Topics:**
- Endpoint structure and naming
- Request/response formats
- Validation patterns
- File upload handling
- IPFS integration
- Error handling and status codes

**When to Reference:**
- Creating new API endpoints
- Adding validation logic
- Working with file uploads
- Integrating IPFS operations
- Handling errors

### 4. Frontend Patterns (`frontend-patterns.mdc`)
**Type:** Context-based (applies to **/client/**, *.jsx, *.js)  
**Scope:** React frontend development

React component patterns, state management, form handling, and UI best practices.

**Key Topics:**
- Component structure
- State management (loading, errors)
- Form validation
- API integration
- Wallet integration
- Dialog/modal patterns
- CSS conventions

**When to Reference:**
- Creating new React components
- Implementing forms
- Handling async operations
- Working with wallet state
- Building dialogs/modals

### 5. Verdikta Manifest Specification (`verdikta-manifest.mdc`)
**Type:** Manual (call explicitly when needed)  
**Scope:** Archive generation and manifest creation

Detailed guide to the Verdikta manifest.json specification and archive structure.

**Key Topics:**
- Complete manifest structure
- Primary vs Hunter archives
- Required fields and formats
- File organization patterns
- Multi-CID workflow
- Common mistakes to avoid

**When to Reference:**
- Working on archive generation
- Debugging manifest issues
- Understanding file references
- Creating new archive types
- Validating archive structure

### 6. Documentation Standards (`documentation-standards.mdc`)
**Type:** Context-based (applies to **/*.md, **/docs/**)  
**Scope:** All documentation files

Guidelines for writing, updating, and maintaining documentation.

**Key Topics:**
- Documentation structure
- When to update docs
- Formatting standards
- Code documentation
- Version history
- Best practices

**When to Reference:**
- Creating new documentation
- Updating existing docs
- Writing inline code comments
- Preparing release notes
- Organizing documentation

## How to Use These Rules

### Automatic Application

Some rules apply automatically based on file context:

```
Working on: example-bounty-program/server/routes/jobRoutes.js
  → bounty-program-architecture.mdc (applies)
  → api-conventions.mdc (applies)
  → .cursorrules (always applies)
```

### Manual Reference

To explicitly reference a rule in your prompt:
```
@verdikta-manifest explain the bCIDs structure
@api-conventions what's the standard error format?
@frontend-patterns how should I structure this component?
```

### Quick Reference

| Task | Primary Rule | Secondary Rules |
|------|-------------|-----------------|
| Create new job endpoint | api-conventions | bounty-program-architecture |
| Build submission UI | frontend-patterns | bounty-program-architecture |
| Generate archives | verdikta-manifest | bounty-program-architecture |
| Write documentation | documentation-standards | - |
| Fix API errors | api-conventions | - |
| Refactor components | frontend-patterns | - |

## Rule Maintenance

### When to Update Rules

Update rules when:
- Architecture patterns change
- New conventions are established
- Common mistakes are identified
- Best practices evolve

### How to Update

1. Edit the relevant `.mdc` file
2. Test that the rule provides helpful guidance
3. Update this README if adding new rules
4. Commit with clear description

### Rule Quality Guidelines

Good rules should:
- ✅ Provide clear, actionable guidance
- ✅ Include concrete examples
- ✅ Link to relevant files
- ✅ Explain the "why" not just "how"
- ✅ Cover common pitfalls
- ✅ Stay focused on one topic

Avoid:
- ❌ Overly verbose explanations
- ❌ Outdated information
- ❌ Vague recommendations
- ❌ Duplicating information across rules

## File References in Rules

Rules use special syntax to reference files:
```markdown
See [filename.js](mdc:path/to/filename.js)
```

This creates a smart reference that Cursor can follow to load the file context.

## Contributing to Rules

When adding new patterns or best practices to the codebase:

1. **Check existing rules** - Does this fit in an existing rule?
2. **Update or create** - Update existing rule or create new focused rule
3. **Add examples** - Include code examples from actual implementation
4. **Test the rule** - Verify it provides helpful guidance
5. **Document in README** - Add to this file if it's a new rule

## Questions?

If you're unsure which rule to reference or how to structure a rule:
- Check similar existing rules for patterns
- Refer to the official Cursor rules documentation
- Look at how rules are applied in the codebase
- Ask for clarification before making major changes

## Related Documentation

- [Project README](../README.md)
- [Bounty Program Docs](../example-bounty-program/README.md)
- [Implementation Summary](../example-bounty-program/IMPLEMENTATION-SUMMARY.md)
- [Testing Guide](../example-bounty-program/TESTING-GUIDE.md)

