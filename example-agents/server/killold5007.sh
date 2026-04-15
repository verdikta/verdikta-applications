#!/bin/bash
# Graceful then force-kill anything listening on port 5007.
lsof -t -i:5007 | xargs -r kill
sleep 1
lsof -t -i:5007 | xargs -r kill -9
