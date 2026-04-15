#!/bin/bash
lsof -t -i:5175 | xargs -r kill
sleep 1
lsof -t -i:5175 | xargs -r kill -9
