// Submit-page help for real-world-task work orders (verdikta-discover's real-world-task-v1): the same file-name check the
// server makes at POST /api/jobs/:id/submit (server/utils/workOrderSubmissionCheck.js), run on the chosen files so the
// hunter sees a mismatch before uploading. The server's check is the one that decides.

/** True when a bounty description carries a real-world-task-v1 work order. */
export function isRealWorldTaskOrder(description) {
  return typeof description === 'string' && description.split('\n').includes('Service: real-world-task-v1');
}

/**
 * Problems with the chosen files of a real-world-task submission, as short sentences (empty when there are none or when
 * result.json cannot be read as a result yet).
 * @param {string|null} resultText  the text of the chosen result.json, or null when no file has that name
 * @param {string[]} fileNames      the names of every chosen file
 */
export function evidenceFileProblems(resultText, fileNames) {
  if (resultText == null) return ['No file is named result.json. A real-world task delivers result.json, evidence.md and every evidence file result.json names.'];
  let result;
  try { result = JSON.parse(resultText); } catch { return ['result.json is not valid JSON.']; }
  const listed = [...new Set((Array.isArray(result?.evidence) ? result.evidence : []).map(e => e?.filename).filter(n => typeof n === 'string' && n))];
  const missing = listed.filter(n => !fileNames.includes(n));
  return missing.length
    ? [`result.json lists ${missing.join(', ')}, but no chosen file has ${missing.length > 1 ? 'those names' : 'that name'}. Rename the files (or correct result.json) so they match exactly.`]
    : [];
}
