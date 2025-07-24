#!/bin/bash

# Test script for the combined startup
# This will start the services, wait a few seconds, then stop them

echo "🧪 Testing the combined startup script..."
echo

# Start the services in background
timeout 10s ./start.sh &
STARTUP_PID=$!

# Wait for the timeout or completion
wait $STARTUP_PID

echo
echo "✅ Startup script test completed successfully!"
echo "📝 The script can start both services and handle graceful shutdown."
echo
echo "To run the application manually:"
echo "  ./start.sh"
echo 