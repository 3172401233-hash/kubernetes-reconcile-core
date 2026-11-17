import { isDeepStrictEqual } from 'node:util';
import { isAlreadyExists, isConflict, isNotFound } from './errors.js';
import { buildDesiredObjects, INSTANCE_LABEL, isOwnedBy } from './desired.js';
import { mergeDesired, objectsEqual } from './equality.js';
import { computePlan, getOrNull, loadSnapshot } from './plan.js';

export const DEFAULT_FINALIZER = 'apps.example.com/webapp-cleanup';

function refOf(obj) {
  return {
    apiVersion: obj.apiVersion,
    kind: obj.kind,
    namespace: obj.metadata.namespace,
    name: obj.metadata.name,
  };
}

export class Reconciler {
  constructor(client, options = {}) {
    this.client = client;
    this.finalizer = options.finalizer ?? DEFAULT_FINALIZER;
    this.maxRetries = options.maxRetries ?? 5;
  }

  async reconcile(cr) {
    if (cr.metadata.deletionTimestamp) {
      return this.reconcileDelete(cr);
    }
    return this.reconcileApply(cr);
  }

  async reconcileApply(cr) {
    cr = await this.ensureFinalizer(cr);
    if (cr.metadata.deletionTimestamp) {
      return this.reconcileDelete(cr);
    }

    const desired = buildDesiredObjects(cr);
    const snapshot = await loadSnapshot(this.client, cr, desired);
    const plan = computePlan(cr, desired, snapshot);

    for (const obj of plan.creates) {
      await this.applyCreate(obj);
    }
    for (const obj of plan.updates) {
      await this.applyUpdate(obj);
    }
    for (const obj of plan.deletes) {
      await this.applyDelete(obj);
    }

    await this.updateStatus(cr, desired);
    return { requeue: false, plan };
  }

  async reconcileDelete(cr) {
    if (!(cr.metadata.finalizers ?? []).includes(this.finalizer)) {
      return { requeue: false };
    }

    const children = await this.client.list(cr.metadata.namespace, {
      [INSTANCE_LABEL]: cr.metadata.name,
    });
    for (const child of children) {
      if (!isOwnedBy(child, cr)) continue;
      await this.applyDelete(child);
    }

    await this.removeFinalizer(cr);
    return { requeue: false };
  }

  async ensureFinalizer(cr) {
    let current = cr;
    for (let attempt = 0; ; attempt += 1) {
      if ((current.metadata.finalizers ?? []).includes(this.finalizer)) {
        return current;
      }
      const next = structuredClone(current);
      next.metadata.finalizers = [...(next.metadata.finalizers ?? []), this.finalizer];
      try {
        return await this.client.update(next);
      } catch (err) {
        if (isConflict(err) && attempt < this.maxRetries) {
          current = await this.client.get(
            cr.apiVersion,
            cr.kind,
            cr.metadata.namespace,
            cr.metadata.name,
          );
          continue;
        }
        throw err;
      }
    }
  }

  async removeFinalizer(cr) {
    let current = cr;
    for (let attempt = 0; ; attempt += 1) {
      const next = structuredClone(current);
      next.metadata.finalizers = (next.metadata.finalizers ?? []).filter(
        (f) => f !== this.finalizer,
      );
      try {
        await this.client.update(next);
        return;
      } catch (err) {
        if (isNotFound(err)) return;
        if (isConflict(err) && attempt < this.maxRetries) {
          current = await this.client.get(
            cr.apiVersion,
            cr.kind,
            cr.metadata.namespace,
            cr.metadata.name,
          );
          continue;
        }
        throw err;
      }
    }
  }

  async applyCreate(desired) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.client.create(desired);
      } catch (err) {
        if (!isAlreadyExists(err) || attempt >= this.maxRetries) throw err;
        const existing = await getOrNull(this.client, desired);
        if (!existing) continue;
        if (objectsEqual(existing, desired)) return existing;
        return this.applyUpdate(mergeDesired(existing, desired));
      }
    }
  }

  async applyUpdate(obj) {
    let next = obj;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.client.update(next);
      } catch (err) {
        if (!isConflict(err) || attempt >= this.maxRetries) throw err;
        const existing = await getOrNull(this.client, next);
        if (!existing) {
          return this.applyCreate(stripRuntimeFields(next));
        }
        if (objectsEqual(existing, next)) return existing;
        next = mergeDesired(existing, next);
      }
    }
  }

  async applyDelete(obj) {
    try {
      await this.client.delete(
        obj.apiVersion,
        obj.kind,
        obj.metadata.namespace,
        obj.metadata.name,
      );
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  }

  async updateStatus(cr, desired) {
    const status = computeStatus(cr, desired);
    let current = cr;
    for (let attempt = 0; ; attempt += 1) {
      if (isDeepStrictEqual(current.status ?? {}, status)) return current;
      const next = structuredClone(current);
      next.status = status;
      try {
        return await this.client.updateStatus(next);
      } catch (err) {
        if (isConflict(err) && attempt < this.maxRetries) {
          current = await this.client.get(
            cr.apiVersion,
            cr.kind,
            cr.metadata.namespace,
            cr.metadata.name,
          );
          continue;
        }
        throw err;
      }
    }
  }
}

function stripRuntimeFields(obj) {
  const copy = structuredClone(obj);
  delete copy.metadata.resourceVersion;
  delete copy.metadata.uid;
  delete copy.metadata.creationTimestamp;
  return copy;
}

function computeStatus(cr, desired) {
  const kinds = desired.map((obj) => obj.kind).sort();
  return {
    observedGeneration: cr.metadata.generation ?? 0,
    managedResources: kinds,
    conditions: [
      {
        type: 'Ready',
        status: 'True',
        reason: 'Reconciled',
        message: `Managed resources converged: ${kinds.join(', ')}`,
      },
    ],
  };
}

export { refOf };
