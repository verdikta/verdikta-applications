const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
// The unzip library @verdikta/common itself unpacks query packages with.
const unzipper = require(require.resolve('unzipper', { paths: [require.resolve('@verdikta/common')] }));
const { classMap } = require('@verdikta/common');
const {
  SOURCE_DIR,
  DEFAULT_CLASS_ID,
  listPackageFiles,
  buildArchive,
  cidV0ForSingleBlock,
  jurorsOutsideClass,
} = require('../scripts/default-query-package');

const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, 'manifest.json'), 'utf8'));
const sha256 = (name) =>
  crypto.createHash('sha256').update(fs.readFileSync(path.join(SOURCE_DIR, name))).digest('hex');

test('every juror of the default package is in the default class pool', () => {
  const classInfo = classMap.getClass(DEFAULT_CLASS_ID);
  assert.strictEqual(classInfo.status, 'ACTIVE');
  assert.deepStrictEqual(jurorsOutsideClass(manifest, classInfo), []);
});

test('a juror the class does not list is reported', () => {
  const retired = {
    juryParameters: {
      AI_NODES: [
        { AI_PROVIDER: 'OpenAI', AI_MODEL: 'gpt-4o' },
        { AI_PROVIDER: 'Anthropic', AI_MODEL: 'claude-3-5-sonnet-20241022' },
      ],
    },
  };
  assert.deepStrictEqual(jurorsOutsideClass(retired, classMap.getClass(DEFAULT_CLASS_ID)), [
    'openai/gpt-4o',
    'anthropic/claude-3-5-sonnet-20241022',
  ]);
});

test('the jury is two equally weighted jurors, one run each, one iteration', () => {
  const { AI_NODES, ITERATIONS, NUMBER_OF_OUTCOMES } = manifest.juryParameters;
  assert.deepStrictEqual(AI_NODES.map((n) => [n.NO_COUNTS, n.WEIGHT]), [[1, 0.5], [1, 0.5]]);
  assert.strictEqual(ITERATIONS, 1);
  assert.strictEqual(NUMBER_OF_OUTCOMES, 2);
});

test('query, outcomes and supporting file are those of the archive this one replaces', () => {
  // SHA-256 of the files in QmSHXfBcrfFf4pnuRYCbHA8rjKkDh1wjqas3Rpk3a2uAWH.
  assert.strictEqual(sha256('primary_query.json'), '10a57c42557583d9bd5c59e911a3018a2b4ea8ff6ac68acbf384cad746028e64');
  assert.strictEqual(sha256('contractTestCode.sol'), '9b129bf874d2b394e3b79d3ca658fe9b42351fa50cd015700363317bc08e3eb6');
});

test('the built archive is reproducible and unpacks to the package source', async () => {
  const { archive, cid } = buildArchive();
  assert.ok(archive.equals(buildArchive().archive));
  assert.match(cid, /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);

  const directory = await unzipper.Open.buffer(archive);
  const unpacked = {};
  for (const entry of directory.files) unpacked[entry.path] = await entry.buffer();
  const source = listPackageFiles();
  assert.deepStrictEqual(Object.keys(unpacked), source.map((f) => f.name));
  for (const { name, data } of source) assert.ok(unpacked[name].equals(data), name);
});

test('single-block CIDv0 matches known IPFS CIDs', () => {
  assert.strictEqual(cidV0ForSingleBlock(Buffer.alloc(0)), 'QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH');
  assert.strictEqual(
    cidV0ForSingleBlock(Buffer.from('hello world\n')),
    'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o'
  );
});
