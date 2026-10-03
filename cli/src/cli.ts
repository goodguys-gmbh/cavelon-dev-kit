#!/usr/bin/env node
import { processIo } from "./io.js";
import { run } from "./main.js";

process.exitCode = await run(process.argv.slice(2), processIo());
