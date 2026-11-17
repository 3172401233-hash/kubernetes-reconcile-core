import { INSTANCE_LABEL, isOwnedBy, keyOf } from './desired.js';
import { mergeDesired, objectsEqual } from './equality.js';

export async function loadSnapshot(client, cr, desired) {
  const existing = new Map();
  for (const obj of desired) {
    existing.set(keyOf(obj), await getOrNull(client, obj));
  }
  const children = await client.list(cr.metadata.namespace, {
    [INSTANCE_LABEL]: cr.metadata.name,
  });
  return { existing, children };
}

export async function getOrNull(client, obj) {
  try {
    return await client.get(
      obj.apiVersion,
      obj.kind,
      obj.metadata.namespace,
      obj.metadata.name,
    );
  } catch (err) {
    if (err.code === 404) return null;
    throw err;
  }
}

export function computePlan(cr, desired, snapshot) {
  const creates = [];
  const updates = [];
  const deletes = [];

  for (const obj of desired) {
    const current = snapshot.existing.get(keyOf(obj));
    if (!current) {
      creates.push(obj);
    } else if (!objectsEqual(current, obj)) {
      updates.push(mergeDesired(current, obj));
    }
  }

  const keep = new Set(desired.map(keyOf));
  for (const child of snapshot.children) {
    if (!isOwnedBy(child, cr)) continue;
    if (!keep.has(keyOf(child))) deletes.push(child);
  }

  return { creates, updates, deletes };
}
