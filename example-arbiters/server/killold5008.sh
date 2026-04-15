#!/bin/bash
# Graceful then force-kill anything listening on port 5008.
lsof -t -i:5008 | xargs -r kill
sleep 1
lsof -t -i:5008 | xargs -r kill -9
