// node:test reporter for settlement.test.ts, in place of node:test's own output. The tests print their lines with
// lib/log.ts; this prints the failures they could not print (hooks, uncaught errors) and the RESULT line at the end.
import type { TestEvent } from "node:test/reporters";
import * as log from "./log.js";

export default async function* reporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  let passed = 0;
  let failed = 0;
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const suite = event.data.details.type === "suite";
    if (event.type === "test:pass") {
      if (!suite) passed += 1;
      continue;
    }
    // A suite fails when one of its tests does (counted on its own) or when one of its hooks throws.
    const err = event.data.details.error as Error & { failureType?: string; cause?: unknown };
    if (suite && err.failureType === "subtestsFailed") continue;
    failed += 1;
    // A test that throws has printed its own [FAIL] line, in order. Other failures reach only this reporter.
    if (err.failureType !== "testCodeFailure") {
      log.fail(`${event.data.name}: ${(err.cause instanceof Error ? err.cause.message : err.message).split("\n")[0]}`);
    }
  }
  // Every failure has a [FAIL] line above it that says where and why, so the RESULT line only counts.
  const total = passed + failed;
  log.result(failed === 0, failed === 0 ? `${total} of ${total} tests passed` : `${failed} of ${total} tests failed`);
}
