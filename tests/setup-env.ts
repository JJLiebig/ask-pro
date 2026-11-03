import os from "node:os";
import path from "node:path";

process.env.ASK_PRO_TEST_HOME ||= path.join(os.tmpdir(), `ask-pro-tests-${process.pid}`);
