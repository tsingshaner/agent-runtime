type CleanFn = () => void | Promise<void>
const listeners = new Set<CleanFn>()

export const cleanup = () => Promise.allSettled(listeners.values().map((fn) => fn()))
export const onShutdown = (fn: CleanFn) => listeners.add(fn)
