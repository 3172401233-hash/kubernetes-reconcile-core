import { isDeepStrictEqual } from 'node:util';

const RUNTIME_METADATA_FIELDS = [
  'resourceVersion',
  'generation',
  'creationTimestamp',
  'deletionTimestamp',
  'deletionGracePeriodSeconds',
  'managedFields',
  'uid',
  'selfLink',
];

export function normalize(obj) {
  const copy = structuredClone(obj);
  copy.metadata = { ...copy.metadata };
  for (const field of RUNTIME_METADATA_FIELDS) {
    delete copy.metadata[field];
  }
  delete copy.status;
  return copy;
}

export function objectsEqual(existing, desired) {
  return isDeepStrictEqual(normalize(existing), normalize(desired));
}

export function mergeDesired(existing, desired) {
  const next = structuredClone(desired);
  next.metadata.resourceVersion = existing.metadata.resourceVersion;
  if (existing.metadata.uid !== undefined) next.metadata.uid = existing.metadata.uid;
  if (existing.metadata.creationTimestamp !== undefined) {
    next.metadata.creationTimestamp = existing.metadata.creationTimestamp;
  }
  if (existing.status !== undefined) next.status = structuredClone(existing.status);
  return next;
}
