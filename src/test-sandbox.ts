import { spawn } from "child_process";
import { resolve } from "path";

const sandboxBin = process.env.NIXBOT_SANDBOX_BIN
  ? resolve(process.env.NIXBOT_SANDBOX_BIN)
  : resolve("./result/bin/run-in-sandbox");

function runInSandbox(
  command: string,
  timeout = 10000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    console.log(
      `[spawn] ${sandboxBin} -- bash -c "${command.slice(0, 50)}..."`,
    );

    const proc = spawn(sandboxBin, [command], {
      env: {
        ...process.env,
        HOME: process.env.HOME || "/tmp",
      },
      cwd: process.env.HOME,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      const s = data.toString();
      console.log(`[stdout] ${s.slice(0, 80).replace(/\n/g, " ")}`);
      stdout += s;
    });

    proc.stderr.on("data", (data) => {
      const s = data.toString();
      console.log(`[stderr] ${s.slice(0, 80).replace(/\n/g, " ")}`);
      stderr += s;
    });

    const timer = setTimeout(() => {
      console.log("[timeout] Killing process...");
      proc.kill("SIGKILL");
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      console.log(`[exit] code=${code}`);
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      console.log(`[error] ${err.message}`);
      resolve({ stdout, stderr: err.message, code: 1 });
    });
  });
}

async function main() {
  console.log("=== Sandbox Test ===\n");
  console.log(`Sandbox bin: ${sandboxBin}\n`);

  console.log("Test 1: Simple echo");
  const r1 = await runInSandbox("echo 'Hello from sandbox'");
  console.log(`stdout: "${r1.stdout.trim()}"\n`);

  console.log("Test 2: Check tools");
  const r2 = await runInSandbox("which chromium || echo 'no chromium'");
  console.log(`Result: ${r2.stdout.trim()}\n`);

  console.log("Test 3: Network (curl)");
  const r3 = await runInSandbox(
    "curl -s -o /dev/null -w '%{http_code}' https://example.com || echo 'failed'",
  );
  console.log(`HTTP code: ${r3.stdout.trim()}\n`);

  console.log("=== Tests complete ===");
}

main().catch(console.error);
