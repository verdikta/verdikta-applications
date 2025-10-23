# Try graceful shutdown first
lsof -t -i:5005 | xargs -r kill
sleep 2
# Force kill any remaining
lsof -t -i:5005 | xargs -r kill -9
