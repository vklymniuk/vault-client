# ManageTeam Vault Client for NodeJS

Simple client for DreamTeam's vault. Defaults to Kubernetes auth method.

Installation
------------

Create `.npmrc` file near the `package.json` file with `registry=http://0.0.0.0:4873/` content. Then install with:

```bash
npm install --save vklymniuk-vault-client
```

Usage
-----

```javascript
import Vault from "vklymniuk-vault-client";

// Every parameter specified below are defaulted to environment variables or hard-coded values, but can be defined explicitly.
const vault = new Vault({
  baseUrl, // Vault base URL. Defaults to process.env.VAULT_BASE_URL
  sslCertPath, // process.env.VAULT_SSL_CERT_PATH
  errorHandler, // Function to redefine vault errors handling (for example, auth failure). Defaults to throwing an exception
  ignoreSslCertCheck: true, // Defauls to false on local and test envs
  authMethod: "kubernetes", // Defaults to env. Can be function (modular auth)
  authOptions: { // Also defaulted
    serviceAccountTokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token", // 
    role: "blockchain"
  },
  token: "" // Directly pass vault token and skip auth if required. Defaults to process.env.VAULT_TOKEN
});

// Perform a request to vault
const data = await vault.request({
  url: "mount/path",
  method: "post",
  data: { /* ... */ }
});
```

Environment variables example:

```bash
VAULT_BASE_URL=vault.nonprod.mt.internal:8200/v1
VAULT_SSL_CERT_PATH=/var/run/secrets/vault/ca.crt
VAULT_AUTH_METHOD=kubernetes
K8S_SERVICE_ACCOUNT_NAME=blockchain
K8S_SERVICE_ACCOUNT_TOKEN_PATH=/var/run/secrets/kubernetes.io/serviceaccount/token
```

+ `VAULT_BASE_URL` is a base URL of a vault. Specify `vault.nonprod.mt.internal:8200/v1` or `vault.prod.mt.internal:8200/v1`.
+ `VAULT_AUTH_METHOD` is a method of auth. Defaults to `kubernetes`.
+ `K8S_SERVICE_ACCOUNT_NAME` is a name of a role for access to Vault.
+ `K8S_SERVICE_ACCOUNT_TOKEN_PATH` is a path to a kubernetes service account token. Mounted by default to all pods and is re-mounted periodically.
+ In order to get `VAULT_SSL_CERT_PATH`, add secret volume and certificate mount to your service deployment file, for example:

```yaml
...
  template:
    spec:
      volumes: # Add new volume from a secret
      - name: vault-ca-cert
        secret:
          secretName: vault-client-tls
          items:
          - key: ca.crt
            path: ca.crt
            mode: 511 # 0777
      serviceAccountName: "$SERVICE_ACCOUNT_NAME" # Specify service account name for auth
      containers:
        - ...
          volumeMounts: # Mount this volume into container
          - name: vault-ca-cert
            mountPath: "/var/run/secrets/vault"
```

Consult with DevOps team in order to set up permissions for your service.

Check [Ethereum Gateway service](http://gitlab-service.mt.ec2-internal/blockchain/ethereum-gateway) for usage example.

License
-------

[MIT](LICENSE) (c) [Volodymyr Klymniuk](Volodymyr.Klymniuk@gmail.com)