# Old way:
# kill -9 $(lsof -t -i:5000)

# New way:
# Try graceful shutdown first
lsof -t -i:5000 | xargs -r kill
sleep 2
# Force kill any remaining
lsof -t -i:5000 | xargs -r kill -9

