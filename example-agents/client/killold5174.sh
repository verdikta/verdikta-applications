#!/bin/bash
lsof -t -i:5174 | xargs -r kill
sleep 1
lsof -t -i:5174 | xargs -r kill -9
