import { createApp } from './app.js';

// 5009: next free port after the repository's other apps (see ../README.md).
const port = Number(process.env.PORT ?? 5009);
const host = process.env.HOST ?? '127.0.0.1';

createApp().listen(port, host, () => {
  console.log(`stake-attestation server listening on http://${host}:${port}`);
});
