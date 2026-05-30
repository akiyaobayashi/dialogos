import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5177);
const URL = `http://localhost:${PORT}/`;

console.log("Starting Dialogos Sales...");

function openBrowser() {
  spawn("cmd", ["/c", "start", "", URL], { detached: true, stdio: "ignore" }).unref();
}

function isPortOpen() {
  return new Promise((resolve) => {
    const sock = createConnection(PORT, "127.0.0.1");
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });
}

async function waitUntilReady(retries = 40) {
  for (let i = 0; i < retries; i += 1) {
    if (await isPortOpen()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

if (await isPortOpen()) {
  console.log(`Dialogos Sales is already running: ${URL}`);
  openBrowser();
  process.exit(0);
}

const server = spawn(process.execPath, [join(__dirname, "server.js")], {
  cwd: __dirname,
  stdio: "inherit",
  env: { ...process.env, PORT: String(PORT) },
});

server.on("error", (err) => {
  console.error("Failed to start server:", err.message);
  process.exit(1);
});

const ready = await waitUntilReady();
if (ready) {
  console.log(`Dialogos Sales ready: ${URL}`);
  openBrowser();
} else {
  console.error("Server did not become ready.");
}

server.on("close", (code) => process.exit(code ?? 0));
