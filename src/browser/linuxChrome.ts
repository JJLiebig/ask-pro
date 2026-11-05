import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";

// A separate supervisor outlives the controller when a browser is kept for resume.
// Its PID represents the managed browser lifetime, including its private display.
export function spawnChromeWithVirtualDisplay(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) {
  const check = spawnSync("Xvfb", ["-help"], { stdio: "ignore" });
  if (check.error)
    throw Error("Xvfb is required on Linux without a display. Run: sudo apt install xvfb");
  return spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--supervise", command, ...args],
    options,
  );
}

async function supervise() {
  const display = spawn(
    "Xvfb",
    ["-displayfd", "3", "-screen", "0", "1280x800x24", "-nolisten", "tcp"],
    {
      stdio: ["ignore", "ignore", "inherit", "pipe"],
    },
  );
  let chrome: ReturnType<typeof spawn> | undefined;
  const stop = () => {
    if (chrome) chrome.kill("SIGTERM");
    else display.kill();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const number = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(Error("Xvfb did not start within 10 seconds")), 10_000);
      let output = "";
      display.once("error", reject);
      display.once("exit", () => reject(Error("Xvfb exited before Chrome started")));
      display.stdio[3]!.on("data", (chunk) => {
        output += String(chunk);
        if (/^\d+\n$/.test(output)) resolve(output.trim());
      });
    }).finally(() => clearTimeout(timer));
    chrome = spawn(process.argv[3]!, process.argv.slice(4), {
      env: { ...process.env, DISPLAY: `:${number}` },
      stdio: "inherit",
    });
    display.once("exit", () => chrome?.kill("SIGTERM"));
    process.exitCode = await new Promise<number>((resolve, reject) => {
      chrome!.once("error", reject);
      chrome!.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    display.kill();
  }
}

if (process.argv[2] === "--supervise") {
  await supervise().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
