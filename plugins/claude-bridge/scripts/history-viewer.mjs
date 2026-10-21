#!/usr/bin/env node
import { runViewer } from "./lib/viewer-runtime.mjs";
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
await runViewer({ directory: process.argv[2], signal: controller.signal });
