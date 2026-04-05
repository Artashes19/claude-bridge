import fs from "node:fs";

export function loadPrompt(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function interpolate(template, replacements) {
  return Object.entries(replacements).reduce(
    (current, [key, value]) => current.replaceAll(`{{${key}}}`, value ?? ""),
    template
  );
}

export function buildReviewPrompt({ template, target, focus, diff, status, diffStat }) {
  return interpolate(template, {
    TARGET: target,
    FOCUS: focus || "No additional focus provided.",
    DIFF: diff,
    STATUS: status,
    DIFF_STAT: diffStat
  });
}

export function buildDelegatePrompt({ template, task, resumeContext }) {
  return interpolate(template, {
    TASK: task,
    RESUME_CONTEXT: resumeContext || "No prior run context."
  });
}
