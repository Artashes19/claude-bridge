import fs from "node:fs";
import path from "node:path";

export function deliveryState(jobsDir, jobId) {
  const dir = path.join(jobsDir, `${jobId}.retrieval`);
  if (!fs.existsSync(dir)) return { retrievedThrough: 0, acknowledgedBytes: null };
  const ranges = [];
  let acknowledgedBytes = null;
  for (const name of fs.readdirSync(dir)) {
    if (/^ack-\d+$/.test(name)) acknowledgedBytes = Math.max(acknowledgedBytes ?? 0, Number(name.slice(4)));
    const match = /^(\d+)-(\d+)$/.exec(name);
    if (match) ranges.push([Number(match[1]), Number(match[2])]);
  }
  let through = 0;
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    if (start > through) break;
    through = Math.max(through, end);
  }
  return { retrievedThrough: through, acknowledgedBytes };
}

export function markRetrieved(jobsDir, jobId, start, end) {
  if (end <= start) return;
  const dir = path.join(jobsDir, `${jobId}.retrieval`);
  fs.mkdirSync(dir, { recursive: true });
  fs.closeSync(fs.openSync(path.join(dir, `${start}-${end}`), "a"));
}

export function reportDelivery(jobsDir, job) {
  const size = job.outputFile && fs.existsSync(job.outputFile) ? fs.statSync(job.outputFile).size : 0;
  const state = deliveryState(jobsDir, job.id);
  const fullyRetrieved = ["completed", "failed", "canceled"].includes(job.status) && size > 0 && state.retrievedThrough >= size;
  return { ...state, fullyRetrieved, acknowledged: fullyRetrieved && state.acknowledgedBytes === size };
}

export function acknowledgeReport(jobsDir, job) {
  if (!reportDelivery(jobsDir, job).fullyRetrieved) throw new Error("Retrieve every report page before acknowledging it.");
  const size = fs.statSync(job.outputFile).size;
  fs.closeSync(fs.openSync(path.join(jobsDir, `${job.id}.retrieval`, `ack-${size}`), "a"));
}
