import { CURRENT_PROTOCOL_VERSION } from "@meepo/protocol";

export async function startWorker(): Promise<void> {
  console.log(`Starting MEEPO Worker (Protocol: ${CURRENT_PROTOCOL_VERSION})...`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWorker().catch((err) => {
    console.error("Failed to start MEEPO worker:", err);
    process.exit(1);
  });
}
