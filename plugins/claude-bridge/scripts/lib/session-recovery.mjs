import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";
import { listJobRecords, updateJobRecord } from "./jobs.mjs";

export function recoverLegacySessions({ jobsDir,
  projectsDir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects") }) {
  const jobs = listJobRecords({ jobsDir }).filter((job) => !job.sessionId && job.request?.prompt &&
    ["completed", "failed", "canceled"].includes(job.status));
  const matches = new Map(jobs.map((job) => [job.id, new Map()]));
  const directories = new Set();
  for (const job of jobs) {
    try {
      for (const cwd of [job.cwd, fs.realpathSync(job.cwd)]) directories.add(path.join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, "-")));
    } catch { continue; }
  }
  let scanned = 0;
  for (const directory of directories) {
    if (!fs.existsSync(directory)) continue;
    for (const filename of fs.readdirSync(directory)) {
      if (!/^[0-9a-f-]{36}\.jsonl$/i.test(filename)) continue;
      const transcript = path.join(directory, filename);
      const consume = (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type !== "user" || event.isSidechain || !event.cwd ||
            event.sessionId !== filename.slice(0, -6)) return;
        const content = event.message?.content;
        const text = typeof content === "string" ? content : Array.isArray(content) ?
          content.filter((block) => block.type === "text").map((block) => block.text).join("") : "";
        for (const job of jobs) {
          const at = Date.parse(event.timestamp), start = Date.parse(job.startedAt), end = Date.parse(job.finishedAt);
          if (text !== job.request.prompt || !Number.isFinite(at) || !Number.isFinite(start) || !Number.isFinite(end) ||
              at < start - 5000 || at > end + 5000) continue;
          try { if (fs.realpathSync(event.cwd) !== fs.realpathSync(job.cwd)) continue; } catch { continue; }
          matches.get(job.id).set(event.sessionId, transcript);
        }
      };
      const fd = fs.openSync(transcript, "r");
      try {
        const decoder = new StringDecoder("utf8"), buffer = Buffer.alloc(65536);
        let pending = "", bytes;
        while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
          pending += decoder.write(buffer.subarray(0, bytes));
          let newline;
          while ((newline = pending.indexOf("\n")) >= 0) {
            consume(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
          }
        }
        pending += decoder.end();
        if (pending.trim()) consume(pending);
      } finally { fs.closeSync(fd); }
      scanned++;
    }
  }
  const recovered = [], ambiguous = [];
  for (const [jobId, candidates] of matches) {
    if (candidates.size > 1) { ambiguous.push(jobId); continue; }
    if (candidates.size === 1) {
      const [sessionId, transcriptFile] = [...candidates][0];
      updateJobRecord({ jobsDir, jobId, patch: { sessionId, sessionReady: true,
        sessionSource: "recovered-transcript", transcriptFile } });
      recovered.push(jobId);
    }
  }
  return { recovered, ambiguous, scanned };
}
