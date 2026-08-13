#!/usr/bin/env node
import { formatHarnessBenchmarkResult, runHarnessBenchmark } from '../tests/agent-harness-benchmark.lib.js';

const report = await runHarnessBenchmark();
console.log(formatHarnessBenchmarkResult(report));
process.exit(report.converged ? 0 : 1);
