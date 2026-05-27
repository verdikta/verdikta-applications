#!/bin/bash
# Build the React client as a STATIC production bundle.
#
# The app is now served in production as a static build via `serve` (see
# ../start.sh / ../fgstart.sh) instead of the react-scripts dev server, which
# cuts client RAM from ~400MB+ to ~30-50MB. Because Create React App bakes
# REACT_APP_* variables at BUILD time, you must rebuild after code changes or to
# change static-config mode, then restart.
#
# Usage:
#   ./buildClient.sh [--staticconfig [classID]]
#   (then, from the project root)  ./restart.sh
set -e
cd "$(dirname "$0")"

STATIC_CONFIG_MODE=false
STATIC_CLASS_ID=128
while [[ $# -gt 0 ]]; do
    case $1 in
        --staticconfig)
            STATIC_CONFIG_MODE=true
            if [[ $# -gt 1 && $2 =~ ^[0-9]+$ ]]; then STATIC_CLASS_ID=$2; shift; fi
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--staticconfig [classID]]"
            exit 1
            ;;
    esac
done

echo "Building client (static-config=$STATIC_CONFIG_MODE, classID=$STATIC_CLASS_ID)..."
# GENERATE_SOURCEMAP=false and a heap cap keep the build's memory footprint down
# (important on small VPSes — the build is the heaviest moment).
REACT_APP_STATIC_CONFIG_MODE="$STATIC_CONFIG_MODE" \
REACT_APP_STATIC_CLASS_ID="$STATIC_CLASS_ID" \
GENERATE_SOURCEMAP=false NODE_OPTIONS=--max-old-space-size=1024 \
npm run build

echo "Build complete: $(pwd)/build"
echo "Restart to serve it:  (from project root)  ./restart.sh"
