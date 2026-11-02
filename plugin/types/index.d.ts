export type RevealedIds = string[]

declare module 'claude-code' {
  interface PluginState {
    gmax: { revealed: RevealedIds }
  }
}
