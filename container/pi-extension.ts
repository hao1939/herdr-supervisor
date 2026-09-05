// Compatibility boundary for old auto-discovery links and launch commands.
export default function removedAutoLoad() {
  throw new Error("Supervisor auto-loading was removed. Start the dedicated Pi with: pi -e /opt/herdr-supervisor/src/extension.ts. Remove old auto-discovery links and mode settings.");
}
