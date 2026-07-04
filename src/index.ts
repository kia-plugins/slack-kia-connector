import type { ExtensionModule } from './kiagent-contracts';
import { createSlackSource } from './source';

const mod = {
  async activate(host) {
    return { sources: [createSlackSource(host)] };
  },
} satisfies ExtensionModule<'net'>;

export default mod;
module.exports = mod;
