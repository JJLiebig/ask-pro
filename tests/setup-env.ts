import os from "node:os";
import path from "node:path";

// Keep tests away from the real browser profiles, runtime builds, and the Codex folder that
// earlier versions kept state in.
const testRoot = path.join(os.tmpdir(), `ask-pro-tests-${process.pid}`);
process.env.ASK_PRO_STATE_DIR = testRoot;
process.env.CODEX_HOME = path.join(testRoot, "codex-home");
