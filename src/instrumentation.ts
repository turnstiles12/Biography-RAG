export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { onServerStart } = await import("./lib/startup");
    await onServerStart();
  }
}
