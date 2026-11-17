import type { RuntimeApi, RuntimeServices, RuntimeConfiguration } from '../../contract/index.mjs';
export type TendrilConfig = RuntimeConfiguration;
export type Bus = { on(type: string, fn: (payload: any) => void): () => void; emit(type: string, payload?: any): void };
export interface RuntimeCore extends Pick<RuntimeServices, 'host' | 'application' | 'device'> {
  bus: Bus;
  config: TendrilConfig;
  ready(): void;
}
declare global { interface Window { __TENDRIL__: TendrilConfig; tendril: RuntimeApi } }
