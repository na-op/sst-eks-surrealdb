# Deploying Distributed SurrealDB on TiKV over Amazon EKS with SST v3 / Pulumi

## 1. Architecture Overview

```
Internet ──► SST Function URL (Hono API)
                  │  VPC Private Routing
                  ▼
        AWS EKS Cluster (SurrealDBCluster)
        ├── Namespace: surrealdb
        │   └── Helm: surrealdb v2.2.2 (Stateless Compute Pods, Port 8000)
        │         │ tikv://basic-pd.tidb-cluster.svc.cluster.local:2379
        │         ▼
        ├── Namespace: tidb-cluster (Managed by PingCAP TiDB Operator v1.6.1)
        │   ├── PD StatefulSet (c7g.large ARM64, gp3 EBS 10Gi, dedicated=pd)
        │   └── TiKV StatefulSet (m7g.xlarge ARM64, gp3 EBS 50Gi, dedicated=tikv)
        └── Addon: aws-ebs-csi-driver (gp3 StorageClass)
```

## 2. Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `AWS_REGION` | `us-east-1` | Target AWS region for VPC, EKS, and Lambda |
| `SURREALDB_USER` | `root` | Initial root username configured on SurrealDB |
| `SURREALDB_PASS` | `surrealdb-root-pass` | Root password passed to SurrealDB & Hono Function |
| `SURREALDB_NS` | `app` | Target SurrealDB namespace |
| `SURREALDB_DB` | `main` | Target SurrealDB database |

## 3. Step-by-Step Deployment

```bash
pnpm install
export AWS_REGION=us-east-1
export SURREALDB_USER=root
export SURREALDB_PASS="$(openssl rand -hex 16)"
npx sst deploy --stage dev
```

### Expected Deployment Stage Progression
1. `SurrealVpc` creates public/private subnets across AZs with managed NAT.
2. `SurrealDBCluster` provisions the EKS control plane, OIDC provider, `aws-ebs-csi-driver`, and dedicated Graviton `pd-nodes` + `tikv-nodes` ManagedNodeGroups with `NO_SCHEDULE` taints.
3. `tidb-crds` + `tidb-operator` (`v1.6.1`) install into `tidb-operator` namespace.
4. `TidbCluster/basic` brings up PD (`2379`) and TiKV (`20160`) pods backed by `gp3` PVCs.
5. `surrealdb` Helm chart (`0.3.7`, image `surrealdb/surrealdb:v2.2.2`) starts against `tikv://basic-pd.tidb-cluster.svc.cluster.local:2379`.
6. `HonoService` deploys with VPC access and outputs `honoServiceUrl` and `surrealUrl`.

## 4. Testing & Verification

```bash
# Verify Hono health & SurrealDB connectivity
curl -s "$HONO_URL/health"
# Create record
curl -s -X POST "$HONO_URL/users" -H "content-type: application/json" -d '{"name":"Alice","role":"engineer"}'
# Query records
curl -s "$HONO_URL/users"
```

## 5. Troubleshooting & Cleanup

- **Pending PD/TiKV PVCs:** Verify `aws-ebs-csi-driver` addon status is `ACTIVE` and `gp3` StorageClass exists (`kubectl get sc`).
- **Pods stuck Pending:** Ensure `dedicated=pd:NoSchedule` and `dedicated=tikv:NoSchedule` node groups reached `Ready` state.
- **Teardown:** Run `npx sst remove --stage dev` to cleanly destroy Function, Helm releases, EKS NodeGroups, Cluster, and VPC.
