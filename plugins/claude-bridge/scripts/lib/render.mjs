export function renderSetupReport(report) {
  return [
    "Claude Bridge setup",
    `READY: ${report.ready ? "yes" : "no"}`,
    `CLAUDE BINARY: ${report.binary}`,
    `CLAUDE VERSION: ${report.version || "unavailable"}`,
    `STATE DIR: ${report.repoStateDir}`,
    report.error ? `ERROR: ${report.error}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderStatusReport(jobs) {
  if (jobs.length === 0) {
    return "No Claude Bridge jobs found for this repository.";
  }

  return [
    "Claude Bridge jobs",
    ...jobs.map(
      (job) => `- ${job.id} | ${job.kind} | ${job.status} | ${job.model} | ${job.summary}`
    )
  ].join("\n");
}

export function renderResultReport(job, outputText) {
  const sections = [
    `Job: ${job.id}`,
    `Kind: ${job.kind}`,
    `Status: ${job.status}`,
    `Model: ${job.model}`
  ];

  const stderrText = (job.stderrTail ?? "").trim();
  if (job.status === "failed" && stderrText) {
    sections.push("", "Diagnostics:", stderrText);
  }

  sections.push("", outputText || "(no output stored)");

  return sections.join("\n");
}
