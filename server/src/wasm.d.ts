declare module '*.wasm' {
  const mod: WebAssembly.Module;
  export default mod;
}

declare module '@jitl/quickjs-ng-wasmfile-release-sync/wasm' {
  const mod: WebAssembly.Module;
  export default mod;
}

declare module '@chronolog/peer-session/sqlite-cas.wasm' {
  const mod: WebAssembly.Module;
  export default mod;
}
