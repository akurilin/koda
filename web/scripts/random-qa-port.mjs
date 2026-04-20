import net from "node:net";

const minPort = 10_000;
const maxPort = 60_000;
const blockedPorts = new Set([3000, 3001, 3002, 3003, 3004, 3005]);

for (let attempt = 0; attempt < 100; attempt += 1) {
  const port = minPort + Math.floor(Math.random() * (maxPort - minPort));

  if (blockedPorts.has(port)) {
    continue;
  }

  if (await isAvailable(port)) {
    process.stdout.write(String(port));
    process.exit(0);
  }
}

throw new Error("Could not find an available QA port.");

function isAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}
