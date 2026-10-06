const { validateRubric } = require('../utils/validation');
const path = require('path');
const root = path.resolve(__dirname, '../../../skills');
for (const name of ['source-check-v1','evidence-pack-v1','review-v1','real-world-task-v1']) {
  test(`${name} template passes canonical rubric validation`, () => {
    const rubric = require(path.join(root, 'verdikta-discover/templates', `${name}.rubric.json`));
    expect(validateRubric(rubric)).toEqual({ valid: true, errors: [] });
    expect(rubric.threshold).toBeUndefined();
  });
}
test('synthetic creator config has a valid rubric and external threshold', () => {
  const example = require(path.join(root, 'verdikta-bounties-onboarding/examples/creator.json'));
  expect(validateRubric(example.rubricJson).valid).toBe(true);
  expect(example.threshold).toBe(85);
  expect(example.fixture_only).toBe(true);
});
test('malformed criteria and non-finite weights fail without crashing', () => {
  for (const rubric of [null, {criteria:[null]}, {criteria:[{id:'x',description:'x',must:false,weight:NaN}]}]) expect(validateRubric(rubric).valid).toBe(false);
});
test('declared procurement intent never silently becomes open', () => {
  const { validateProcurement } = require('../utils/validation');
  const target = '0x1111111111111111111111111111111111111111';
  const zero = '0x0000000000000000000000000000000000000000';
  expect(validateProcurement('TARGETED', target)).toBeNull();
  expect(validateProcurement('OPEN', zero)).toBeNull();
  expect(validateProcurement(undefined, undefined)).toBeNull();
  for (const input of [undefined, '', zero, 'bad']) expect(validateProcurement('TARGETED', input)).not.toBeNull();
  expect(validateProcurement('OPEN', target)).not.toBeNull();
});
