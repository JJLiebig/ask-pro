import os from "node:os";
import path from "node:path";

// Keep tests away from the real browser profile and runtime builds.
process.env.ASK_PRO_STATE_DIR ||= path.join(os.tmpdir(), `ask-pro-tests-${process.pid}`);
