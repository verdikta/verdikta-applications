#!/usr/bin/env node
import { run } from '../src/cli.js';

process.exitCode = run(process.argv.slice(2));
