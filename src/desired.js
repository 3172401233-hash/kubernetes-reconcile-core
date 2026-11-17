export const MANAGED_BY = 'webapp-controller';
export const INSTANCE_LABEL = 'app.kubernetes.io/instance';

export function keyOf(obj) {
  const { namespace = '', name } = obj.metadata;
  return `${obj.apiVersion}/${obj.kind}/${namespace}/${name}`;
}

export function isOwnedBy(obj, cr) {
  return (obj.metadata.ownerReferences ?? []).some(
    (ref) => ref.controller === true && ref.uid === cr.metadata.uid,
  );
}

function ownerReference(cr) {
  return {
    apiVersion: cr.apiVersion,
    kind: cr.kind,
    name: cr.metadata.name,
    uid: cr.metadata.uid,
    controller: true,
    blockOwnerDeletion: true,
  };
}

function baseMetadata(cr) {
  return {
    name: cr.metadata.name,
    namespace: cr.metadata.namespace,
    labels: {
      'app.kubernetes.io/name': cr.metadata.name,
      [INSTANCE_LABEL]: cr.metadata.name,
      'app.kubernetes.io/managed-by': MANAGED_BY,
    },
    ownerReferences: [ownerReference(cr)],
  };
}

export function buildDesiredObjects(cr) {
  const port = cr.spec.port ?? 80;
  const podLabels = {
    'app.kubernetes.io/name': cr.metadata.name,
    [INSTANCE_LABEL]: cr.metadata.name,
  };

  const configMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: baseMetadata(cr),
    data: { ...(cr.spec.config ?? {}) },
  };

  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: baseMetadata(cr),
    spec: {
      replicas: cr.spec.replicas ?? 1,
      selector: { matchLabels: podLabels },
      template: {
        metadata: { labels: podLabels },
        spec: {
          containers: [
            {
              name: 'app',
              image: cr.spec.image,
              ports: [{ containerPort: port }],
            },
          ],
        },
      },
    },
  };

  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: baseMetadata(cr),
    spec: {
      selector: podLabels,
      ports: [{ port, targetPort: port }],
    },
  };

  return [configMap, deployment, service];
}
