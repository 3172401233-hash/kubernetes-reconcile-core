import { isDeepStrictEqual } from 'node:util';
import { ApiError } from './errors.js';

function storeKey(apiVersion, kind, namespace, name) {
  return `${apiVersion}/${kind}/${namespace ?? ''}/${name}`;
}

function matchesLabels(obj, selector) {
  const labels = obj.metadata.labels ?? {};
  return Object.entries(selector).every(([k, v]) => labels[k] === v);
}

export class FakeClient {
  constructor() {
    this.store = new Map();
    this.resourceVersion = 0;
    this.calls = [];
    this.faults = [];
    this.beforeUpdateHooks = [];
  }

  failNext(method, error, times = 1) {
    this.faults.push({ method, error, times });
  }

  checkFault(method) {
    const fault = this.faults.find((f) => f.method === method && f.times > 0);
    if (!fault) return;
    fault.times -= 1;
    if (fault.times === 0) this.faults.splice(this.faults.indexOf(fault), 1);
    throw fault.error;
  }

  record(method, apiVersion, kind, namespace, name) {
    this.calls.push({ method, apiVersion, kind, namespace, name });
  }

  nextResourceVersion() {
    this.resourceVersion += 1;
    return String(this.resourceVersion);
  }

  async get(apiVersion, kind, namespace, name) {
    this.record('get', apiVersion, kind, namespace, name);
    this.checkFault('get');
    const obj = this.store.get(storeKey(apiVersion, kind, namespace, name));
    if (!obj) {
      throw new ApiError(404, 'NotFound', `${kind} "${name}" not found`);
    }
    return structuredClone(obj);
  }

  async list(namespace, labelSelector = {}) {
    this.record('list', '*', '*', namespace, '*');
    this.checkFault('list');
    const out = [];
    for (const obj of this.store.values()) {
      if (obj.metadata.namespace !== namespace) continue;
      if (!matchesLabels(obj, labelSelector)) continue;
      out.push(structuredClone(obj));
    }
    return out;
  }

  async create(obj) {
    this.record('create', obj.apiVersion, obj.kind, obj.metadata.namespace, obj.metadata.name);
    this.checkFault('create');
    const key = storeKey(obj.apiVersion, obj.kind, obj.metadata.namespace, obj.metadata.name);
    if (this.store.has(key)) {
      throw new ApiError(
        409,
        'AlreadyExists',
        `${obj.kind} "${obj.metadata.name}" already exists`,
      );
    }
    const stored = structuredClone(obj);
    stored.metadata.resourceVersion = this.nextResourceVersion();
    stored.metadata.uid = stored.metadata.uid ?? `uid-${key}`;
    stored.metadata.creationTimestamp = new Date().toISOString();
    this.store.set(key, stored);
    return structuredClone(stored);
  }

  async update(obj) {
    this.record('update', obj.apiVersion, obj.kind, obj.metadata.namespace, obj.metadata.name);
    this.checkFault('update');
    const key = storeKey(obj.apiVersion, obj.kind, obj.metadata.namespace, obj.metadata.name);
    const stored = this.store.get(key);
    if (!stored) {
      throw new ApiError(404, 'NotFound', `${obj.kind} "${obj.metadata.name}" not found`);
    }
    for (const hook of this.beforeUpdateHooks) hook(obj, stored, this);
    if (obj.metadata.resourceVersion !== stored.metadata.resourceVersion) {
      throw new ApiError(
        409,
        'Conflict',
        `${obj.kind} "${obj.metadata.name}" has been modified`,
      );
    }
    const next = structuredClone(obj);
    next.metadata.resourceVersion = this.nextResourceVersion();
    next.metadata.uid = stored.metadata.uid;
    next.metadata.creationTimestamp = stored.metadata.creationTimestamp;
    const hadDeletionTimestamp = stored.metadata.deletionTimestamp !== undefined;
    const finalizers = next.metadata.finalizers ?? [];
    if (hadDeletionTimestamp && finalizers.length === 0) {
      this.store.delete(key);
      return structuredClone(next);
    }
    this.store.set(key, next);
    return structuredClone(next);
  }

  async updateStatus(obj) {
    this.record('updateStatus', obj.apiVersion, obj.kind, obj.metadata.namespace, obj.metadata.name);
    this.checkFault('updateStatus');
    const key = storeKey(obj.apiVersion, obj.kind, obj.metadata.namespace, obj.metadata.name);
    const stored = this.store.get(key);
    if (!stored) {
      throw new ApiError(404, 'NotFound', `${obj.kind} "${obj.metadata.name}" not found`);
    }
    for (const hook of this.beforeUpdateHooks) hook(obj, stored, this);
    if (obj.metadata.resourceVersion !== stored.metadata.resourceVersion) {
      throw new ApiError(
        409,
        'Conflict',
        `${obj.kind} "${obj.metadata.name}" has been modified`,
      );
    }
    const next = structuredClone(stored);
    next.status = structuredClone(obj.status ?? {});
    next.metadata.resourceVersion = this.nextResourceVersion();
    this.store.set(key, next);
    return structuredClone(next);
  }

  async delete(apiVersion, kind, namespace, name) {
    this.record('delete', apiVersion, kind, namespace, name);
    this.checkFault('delete');
    const key = storeKey(apiVersion, kind, namespace, name);
    if (!this.store.has(key)) {
      throw new ApiError(404, 'NotFound', `${kind} "${name}" not found`);
    }
    this.store.delete(key);
  }

  snapshotObjects() {
    return [...this.store.values()].map((obj) => structuredClone(obj));
  }

  mutationCalls() {
    return this.calls.filter((c) => c.method !== 'get' && c.method !== 'list');
  }

  clearCalls() {
    this.calls = [];
  }
}

export function objectsInStoreEqual(a, b) {
  const norm = (objs) =>
    objs
      .map((obj) => {
        const copy = structuredClone(obj);
        delete copy.metadata.resourceVersion;
        delete copy.metadata.creationTimestamp;
        delete copy.status;
        return copy;
      })
      .sort((x, y) =>
        `${x.apiVersion}/${x.kind}/${x.metadata.name}`.localeCompare(
          `${y.apiVersion}/${y.kind}/${y.metadata.name}`,
        ),
      );
  return isDeepStrictEqual(norm(a), norm(b));
}
