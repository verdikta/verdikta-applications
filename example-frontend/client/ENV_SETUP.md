# Environment Configuration

## Client .env File

The client `.env` file contains important configuration that should be set up before running the application.

### Required Settings

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

### Configuration Options

#### Contract Configuration
```bash
REACT_APP_CONTRACT_ADDRESSES=0x...  # Comma-separated list of contract addresses
REACT_APP_CONTRACT_NAMES=Name1,Name2  # Corresponding names for each contract
REACT_APP_CONTRACT_CLASSES=128,128  # Class IDs for each contract
```

#### Client Configuration  
```bash
PORT=3000  # Port for React development server (default: 3000)
REACT_APP_SERVER_URL=http://localhost:5000  # Backend server URL
```

#### Build Configuration
```bash
GENERATE_SOURCEMAP=false  # Set to false for faster builds
```

#### Network Configuration
```bash
# REACT_APP_NETWORK=base_sepolia  # Uncomment to override default network
```

### Important Notes

- The `.env` file is NOT tracked in git (user-specific configuration)
- Do NOT commit your `.env` file with sensitive addresses
- The startup scripts will NOT modify your `.env` file
- Environment variables passed via command line or exported before `npm start` will override `.env` settings

### Static Configuration Mode

When using `--staticconfig` flag with startup scripts:

```bash
./start.sh --staticconfig 128
```

The following environment variables are exported (override `.env`):
- `REACT_APP_STATIC_CONFIG_MODE=true`
- `REACT_APP_STATIC_CLASS_ID=128` (or your specified class ID)

These do NOT modify your `.env` file - they are only exported for that session.
