// biome-ignore-all lint/suspicious/noConsole: Standalone probe output.
if (process.env.RUN_CODEX_ISOLATION !== '1') {
  console.log('SKIPPED: Codex isolation probe not enabled')
} else {
  if (!process.env.CODEX_MODEL) {
    throw new Error('CODEX_MODEL must be explicit')
  }
  const probe = await import(new URL('./dist/probe.mjs', import.meta.url).href)
  console.log(JSON.stringify(await probe.runProbe(), null, 2))
}
