// @verdikta/common's code-review module (CommonJS), this package's pinned copy: the same release the
// server, the tool and the arbiter's packages pin.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const { codeReview } = require('@verdikta/common');
