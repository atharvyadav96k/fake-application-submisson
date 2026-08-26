import { createLogger } from '@/utils/logger';
import { genericAdapter } from './generic-adapter';
import { indeedAdapter } from './portals/indeed-adapter';
import { naukriAdapter } from './portals/naukri-adapter';
import { examplePortalAdapter } from './portals/example-portal';
import type { AdapterContext, PortalAdapter } from './types';

const log = createLogger('adapters');

class AdapterManager {
  private readonly adapters: PortalAdapter[] = [];

  constructor(initial: PortalAdapter[] = []) {
    for (const a of initial) this.register(a);
  }

  register(adapter: PortalAdapter): void {
    if (this.adapters.some((a) => a.name === adapter.name)) return;
    this.adapters.push(adapter);
    this.adapters.sort((a, b) => b.priority - a.priority);
  }

  unregister(name: string): void {
    const idx = this.adapters.findIndex((a) => a.name === name);
    if (idx >= 0) this.adapters.splice(idx, 1);
  }

  list(): readonly PortalAdapter[] {
    return this.adapters;
  }

  select(url: URL): PortalAdapter {
    for (const adapter of this.adapters) {
      if (adapter.kind === 'generic') continue;
      try {
        if (adapter.matches(url)) {
          log.debug('selected adapter', adapter.name, 'for', url.hostname);
          return adapter;
        }
      } catch (err) {
        log.warn('adapter matches() threw', adapter.name, err);
      }
    }
    return genericAdapter;
  }

   safeCall<K extends keyof PortalAdapter, R>(
    adapter: PortalAdapter,
    method: K,
    invoke: (a: PortalAdapter) => R,
    fallback: R,
  ): R {
    try {
      return invoke(adapter);
    } catch (err) {
      log.warn(`adapter.${String(method)} threw in ${adapter.name}`, err);
      if (adapter !== genericAdapter) {
        try {
          return invoke(genericAdapter);
        } catch {
          /* fall through */
        }
      }
      return fallback;
    }
  }

  contextFor(doc: Document = document): AdapterContext {
    return {
      url: new URL(doc.defaultView?.location.href ?? location.href),
      document: doc,
      isFrame: typeof window !== 'undefined' && window.top !== window.self,
    };
  }
}

export const adapterManager = new AdapterManager([examplePortalAdapter, indeedAdapter, naukriAdapter, genericAdapter]);
export { AdapterManager };
export { genericAdapter };
