import * as eks from "@pulumi/eks";
import * as kubernetes from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface SurrealTiKVConfig {
  rootUser?: string;
  rootPass?: pulumi.Input<string>;
  tikvReplicas?: number;
  pdReplicas?: number;
}

export const setupSurrealdb = async (vpc: sst.aws.Vpc, cfg: SurrealTiKVConfig = {}) => {
  const rootUser = cfg.rootUser ?? process.env.SURREALDB_USER ?? "root";
  const rootPass = cfg.rootPass ?? process.env.SURREALDB_PASS ?? "surrealdb-root-pass";
  const pdReplicas = cfg.pdReplicas ?? 3;
  const tikvReplicas = cfg.tikvReplicas ?? 3;

  const cluster = new eks.Cluster("SurrealDBCluster", {
    vpcId: vpc.id,
    publicSubnetIds: vpc.publicSubnets,
    privateSubnetIds: vpc.privateSubnets,
    instanceType: "t3.medium",
    desiredCapacity: 2,
    minSize: 1,
    maxSize: 3,
    storageClasses: "gp3",
    skipDefaultNodeGroup: false,
    createOidcProvider: true,
  });

  const ebsCsiDriverAddon = new eks.Addon("aws-ebs-csi-driver", {
    cluster,
    addonName: "aws-ebs-csi-driver",
  });

  const instanceRoleArn = cluster.instanceRoles.apply((roles) => roles[0].arn);

  const pdNodeGroup = new eks.ManagedNodeGroup("pd-nodegroup", {
    cluster,
    nodeGroupName: "pd-nodes",
    instanceTypes: ["c7g.large"],
    amiType: "AL2023_ARM_64_STANDARD",
    scalingConfig: { desiredSize: pdReplicas, minSize: pdReplicas, maxSize: pdReplicas + 1 },
    labels: { dedicated: "pd" },
    taints: [{ key: "dedicated", value: "pd", effect: "NO_SCHEDULE" }],
    subnetIds: vpc.privateSubnets,
    nodeRoleArn: instanceRoleArn,
  });

  const tikvNodeGroup = new eks.ManagedNodeGroup("tikv-nodegroup", {
    cluster,
    nodeGroupName: "tikv-nodes",
    instanceTypes: ["m7g.xlarge"],
    amiType: "AL2023_ARM_64_STANDARD",
    scalingConfig: { desiredSize: tikvReplicas, minSize: tikvReplicas, maxSize: tikvReplicas + 2 },
    labels: { dedicated: "tikv" },
    taints: [{ key: "dedicated", value: "tikv", effect: "NO_SCHEDULE" }],
    subnetIds: vpc.privateSubnets,
    nodeRoleArn: instanceRoleArn,
  });

  const provider = new kubernetes.Provider("eks-provider", {
    kubeconfig: cluster.kubeconfigJson,
  });

  const tidbCrds = new kubernetes.yaml.ConfigFile("tidb-crds", {
    file: "https://raw.githubusercontent.com/pingcap/tidb-operator/v1.6.1/manifests/crd.yaml",
  }, { provider });

  const tidbOperatorNs = new kubernetes.core.v1.Namespace("tidb-operator-ns", {
    metadata: { name: "tidb-operator" },
  }, { provider });

  const tidbOperator = new kubernetes.helm.v3.Release("tidb-operator", {
    chart: "tidb-operator",
    version: "v1.6.1",
    repositoryOpts: { repo: "https://charts.pingcap.org" },
    namespace: tidbOperatorNs.metadata.name,
  }, { provider, dependsOn: [tidbCrds, tidbOperatorNs] });

  const tidbClusterNs = new kubernetes.core.v1.Namespace("tidb-cluster-ns", {
    metadata: { name: "tidb-cluster" },
  }, { provider });

  const tidbCluster = new kubernetes.apiextensions.CustomResource("tidb-cluster", {
    apiVersion: "pingcap.com/v1alpha1",
    kind: "TidbCluster",
    metadata: { name: "basic", namespace: "tidb-cluster" },
    spec: {
      version: "v8.5.0",
      timezone: "UTC",
      tlsCluster: { enabled: false },
      pd: {
        replicas: pdReplicas,
        storageClassName: "gp3",
        requests: { storage: "10Gi" },
        nodeSelector: { dedicated: "pd" },
        tolerations: [{ key: "dedicated", value: "pd", effect: "NoSchedule" }],
      },
      tikv: {
        replicas: tikvReplicas,
        storageClassName: "gp3",
        requests: { storage: "50Gi" },
        nodeSelector: { dedicated: "tikv" },
        tolerations: [{ key: "dedicated", value: "tikv", effect: "NoSchedule" }],
      },
    },
  }, { provider, dependsOn: [tidbOperator, tidbClusterNs, pdNodeGroup, tikvNodeGroup, ebsCsiDriverAddon] });

  const surrealNs = new kubernetes.core.v1.Namespace("surrealdb-ns", {
    metadata: { name: "surrealdb" },
  }, { provider });

  const surrealRelease = new kubernetes.helm.v3.Release("surrealdb", {
    chart: "surrealdb",
    repositoryOpts: { repo: "https://surrealdb.github.io/helm-charts" },
    version: "0.3.7",
    namespace: surrealNs.metadata.name,
    values: {
      image: { repository: "surrealdb/surrealdb", tag: "v2.2.2", pullPolicy: "IfNotPresent" },
      surrealdb: {
        path: "tikv://basic-pd.tidb-cluster.svc.cluster.local:2379",
        auth: true,
        initialUser: rootUser,
        initialPassword: rootPass,
      },
      service: { type: "LoadBalancer", port: 8000 },
    },
  }, { provider, dependsOn: [tidbCluster, surrealNs] });

  const surrealSvc = kubernetes.core.v1.Service.get(
    "surrealdb-svc",
    pulumi.interpolate`${surrealNs.metadata.name}/${surrealRelease.name}`,
    { provider, dependsOn: [surrealRelease] }
  );

  const endpointHost = surrealSvc.status.loadBalancer.ingress[0].hostname;
  const surrealUrl = pulumi.interpolate`http://${endpointHost}:8000/rpc`;

  return { kubeconfig: cluster.kubeconfigJson, surrealUrl, rootUser };
};
