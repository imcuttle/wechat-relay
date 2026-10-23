import type { RelayApi } from '../shared/types';

declare global {
  interface Window { relay: RelayApi }
}
export {};
