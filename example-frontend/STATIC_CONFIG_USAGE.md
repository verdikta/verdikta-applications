# Static Configuration Mode

The Verdikta Example Frontend now supports a static configuration mode that restricts user access to contract management and AI class selection.

## Usage

### Basic Static Configuration
```bash
./start.sh --staticconfig
```
This enables static configuration mode with the default class ID of 128.

### Static Configuration with Custom Class ID
```bash
./start.sh --staticconfig 256
```
This enables static configuration mode with class ID 256.

## Features

When static configuration mode is enabled:

1. **Contract Management Suppressed**: 
   - The "Manage Contracts" option is hidden from the contract selector dropdown
   - Users cannot navigate to the Contract Management page
   - The "+" and refresh buttons for contract management are hidden

2. **AI Class Selection Suppressed**:
   - The ClassSelector component is hidden on both Query Definition and Jury Selection pages
   - A static information panel shows the current class ID being used
   - Users cannot change the AI class during their session

3. **Default Class ID**:
   - If no class ID is specified with `--staticconfig`, it defaults to class 128
   - The specified class ID is used throughout the application session

## Implementation Details

- The feature uses environment variables (`REACT_APP_STATIC_CONFIG_MODE` and `REACT_APP_STATIC_CLASS_ID`) passed from the startup script
- The React application reads these variables and conditionally renders components
- Class selection changes are ignored in static configuration mode
- The initial class ID is set based on the static configuration

## Normal Mode

To run the application in normal mode (with full functionality):
```bash
./start.sh
```

This allows users to manage contracts and select AI classes as usual.
