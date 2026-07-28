import type { ExtensionModule } from './kiagent-contracts';
import { createSlackSender } from './sender';
import { createSlackSource } from './source';

const mod = {
  async activate(host) {
    return {
      sources: [createSlackSource(host)],
      // Keyed by SOURCE id, and listed in manifest contributes.senders.
      senders: { slack: createSlackSender(host) },
    };
  },
} satisfies ExtensionModule<'net' | 'send'>;

export default mod;
module.exports = mod;
