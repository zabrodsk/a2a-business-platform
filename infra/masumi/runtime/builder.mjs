// Backport Masumi's official cost-model synchronization to the pinned V1 API.
// Source: d569a338ca54d5be7441564770d75ebf89b71f12, utils/mesh-cost-model-sync.
import { MeshTxBuilder } from '@meshsdk/core';
import { syncMeshCostModelsFromChain, withMeshCostModelLock } from './mesh-cost-model-sync/index.ts';

export class ChainSyncedMeshTxBuilder extends MeshTxBuilder {
  constructor(...args) {
    super(...args);
    const complete = this.complete;
    this.complete = async (...buildArgs) => {
      const key = process.env.BLOCKFROST_API_KEY_PREPROD;
      if (!key?.startsWith('preprod')) throw new Error('A Preprod RPC key is required to build transactions.');
      return withMeshCostModelLock(key, async () => {
        const protocol = await syncMeshCostModelsFromChain(key);
        this.protocolParams(protocol);
        return complete(...buildArgs);
      });
    };
  }
}
