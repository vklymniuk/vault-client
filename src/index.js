const { readFile, existsSync } = require("fs");
const { Agent } = require("https");
const { post, request } = require("axios");

const tokenRenewalCliff = 30 * 1000; // 30 seconds before expiration

async function readFileAsync (...params) { // Async wrapper around fs.readFile
    return new Promise((resolve, reject) => readFile(...params.concat((err, data) => err ? reject(err) : resolve(data))));
}

const defaults = {
    getIgnoreSslCertCheck: () => process.env.APP__ENV_NAME === "local" || process.env.APP__ENV_NAME === "test",
    getBaseUrl: () => process.env.VAULT_BASE_URL || "vault.nonprod.manageteam.internal:8200/v1",
    getErrorHandler: () => ((e) => {
        throw new Error(`ManageTeamVault module error: ${ e.message || e }`);
    }),
    getAuthRole: () => process.env.K8S_SERVICE_ACCOUNT_NAME || "blockchain",
    getAuthServiceAccountPath: () => process.env.K8S_SERVICE_ACCOUNT_TOKEN_PATH || "/var/run/secrets/kubernetes.io/serviceaccount/token",
    getSslCertPath: () => process.env.VAULT_CA_CERT_PATH || "/var/run/secrets/vault/ca.crt",
    getToken: () => process.env.VAULT_TOKEN || "",
    getAuthMethod: () => process.env.VAULT_AUTH_METHOD || "kubernetes",
};

const authMethods = {

    /**
     * Kubernetes auth which uses service account for authorization.
     * @param {Object} options - Auth options.
     * @param {string} [options.serviceAccountTokenPath=/var/run/secrets/kubernetes.io/serviceaccount/token] - Defaults to env.K8S_SERVICE_ACCOUNT_TOKEN_PATH.
     * @param {string} [options.role=blockchain] - Defaults to env.K8S_SERVICE_ACCOUNT_NAME or `blockchain`.
     * 
     * @this {ManageTeamVault}
     * 
     * @returns {string} - Vault token.
     */
    "kubernetes": async function ({
        serviceAccountTokenPath = defaults.getAuthServiceAccountPath(),
        role = defaults.getAuthRole()
    } = {}) {
        let response;

        if (!existsSync(serviceAccountTokenPath)) {
            throw new Error(`serviceAccountTokenPath: file not found ${ serviceAccountTokenPath }`);
        }

        try {

            response = await post(`${ this.baseUrl }/auth/kubernetes/login`, {
                jwt: (await readFileAsync(serviceAccountTokenPath)).toString(),
                role: role
            }, {
                httpsAgent: await this.getHttpsAgent()
            });

        } catch (e) {
            this.errorHandler(new Error(
                `Vault token refresh error: unsuccessful POST ${ this.baseUrl }/auth/kubernetes/login, ${ e.message || e
                }${ e.response && e.response.data ? `; Server response: ${ JSON.stringify(e.response.data, null, 4) }` : "" }`
            ));

            return this.token;
        }

        if (!response || !response.data || !response.data.auth || !response.data.auth.client_token) {
            this.errorHandler(new Error(`Vault auth: unrecognized response: ${ JSON.stringify(response.data) }`));
            return this.token;
        }

        this.token = response.data.auth.client_token;
        this.tokenExpiresAt = Date.now() + response.data.auth.lease_duration * 1000;

        return this.token;
    }
};

export default class ManageTeamVault {

    /**
     * Set up new ManageTeam Vault instance.
     * 
     * @param { Object } config - Initial config.
     * @param { String } [config.baseUrl=vault.nonprod.manageteam.internal:8200/v1] - Defaults to env.VAULT_BASE_URL.
     * @param { String } [config.sslCertPath=/var/run/secrets/vault/ca.crt] - Defaults to env.VAULT_CA_CERT_PATH.
     * @param { String|Function } [config.authMethod=kubernetes] - Auth method to use. Allows to pass functions for modularity.
     * @param { Object } [config.authOptions] - Options for auth method.
     * @param { Boolean } [config.ignoreSslCertCheck] - Ignores sslCertPath and SSL issues (default for local and test environments).
     * @param { String } [config.token] - Static token to use with Vault. If specified, serviceAccountTokenPath is ignored.
     * @param { Function } [config.errorHandler] - If defined, connection and token renewal exceptions will be caught by handler.
     */
    constructor ({
        baseUrl = defaults.getBaseUrl(),
        sslCertPath = defaults.getSslCertPath(),
        errorHandler = defaults.getErrorHandler(),
        ignoreSslCertCheck = defaults.getIgnoreSslCertCheck(),
        token = defaults.getToken(),
        authMethod = defaults.getAuthMethod(),
        authOptions = {}
    } = {}) {

        if (typeof(authMethod) === "string" && !authMethods.hasOwnProperty(authMethod)) {
            throw new Error(`Vault: Unsupported auth method ${ authMethod }`);
        }

        if (!existsSync(sslCertPath) && !ignoreSslCertCheck) {
            throw new Error(`sslCertPath: file not found ${ sslCertPath }`);
        }

        if (!baseUrl) {
            throw new Error(`Invalid baseUrl constructor parameter (${ baseUrl })`);
        }

        this.auth = async () => typeof(authMethod) === "function"
            ? await authMethod.call(this, authOptions)
            : await authMethods[authMethod].call(this, authOptions);

        this.ignoreSslCertCheck = ignoreSslCertCheck;
        this.baseUrl = `https://${ baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "") }`;
        this.sslCertPath = sslCertPath;
        this.httpsAgent = null;
        this.errorHandler = errorHandler;
        this.token = token || "";
        this.tokenExpiresAt = token ? Date.now() + 31 * 24 * 60 * 60 * 1000 : 0;
    }

    /**
     * General function to make authenticated HTTP(s) request to vault. Throws if request was not successful.
     * @param { Object } params - Request parameters (for axios module).
     * @param { String } [params.baseUrl] - Optional base URL.
     * @param { String } params.url - Request URL (excluding baseUrl).
     * @param { String } [params.method=post] - Request method.
     * @param {*} [params.data] - Request body (application/json by default).
     * 
     * @returns {*} - Returned data.
     */
    async request (params) {
        params = Object.assign({
            baseURL: this.baseUrl,
            method: "post",
            httpsAgent: await this.getHttpsAgent(),
        }, params);

        params.headers = Object.assign({
            "X-Vault-Token": await this.getToken()
        }, params.headers || {});

        try {
            const response = await request(params);

            return response.data;
        } catch (e) {
            return this.errorHandler(new Error(
                `Vault: ${ params.method } request to ${ params.baseURL }${ params.url } failed, ${ e
                }${ e.response && e.response.data ? `; Server response: ${ JSON.stringify(e.response.data, null, 4) }` : ""
                }; Request data: ${ JSON.stringify(params.data) || "((empty))" }; Token: ${ this.token }`
            ));
        }
    }

    /**
     * Refreshes vault token if it needs refreshment. Sets this.token to a refreshed token.
     * Triggers this.errorHandler on any errors.
     * 
     * @returns { String } - Actual token.
     */
    async getToken () {
        return this.tokenExpiresAt - tokenRenewalCliff > Date.now() ? this.token : await this.auth();
    }

    async getHttpsAgent () {
        const config = {};

        if (this.httpsAgent) {
            return this.httpsAgent;
        }

        if (this.ignoreSslCertCheck) {
            config.rejectUnauthorized = false;
        } else {
            config.ca = (await readFileAsync(this.sslCertPath)).toString();
        }

        return this.httpsAgent = new Agent(config);
    }
}