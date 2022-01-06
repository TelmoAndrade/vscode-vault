import * as vscode from 'vscode';
import * as url from 'url';
import * as nv from 'node-vault';

import { VaultConfiguration } from './config';
import * as model from '../model';

interface VaultToken {
    id: string;
    renewable: boolean;
    ttl: number;
}

export class VaultConnection implements vscode.Disposable {
    private tokenTimer: NodeJS.Timer | null = null;

    constructor(
        private readonly vaultConfiguration: VaultConfiguration,
        private vaultClient?: nv.client
    ) {
        const endpointUrl = new url.URL(vaultConfiguration.endpoint);

        vaultConfiguration.endpoint = url.format(endpointUrl).replace(/\/$/, '');
    }

    isVaultConfiguration(vaultConfiguration: VaultConfiguration): boolean {
        const endpointUrl = new url.URL(vaultConfiguration.endpoint);
        const endpoint = url.format(endpointUrl).replace(/\/$/, '');

        return this.vaultConfiguration.name === vaultConfiguration.name &&
            this.vaultConfiguration.endpoint === endpoint &&
            this.vaultConfiguration.auth.method === vaultConfiguration.auth.method &&
            this.vaultConfiguration.auth.token === vaultConfiguration.auth.token &&
            this.vaultConfiguration.auth.mountPoint === vaultConfiguration.auth.mountPoint &&
            this.vaultConfiguration.auth.username === vaultConfiguration.auth.username &&
            this.vaultConfiguration.auth.password === vaultConfiguration.auth.password;
    }

    get name(): string {
        return this.vaultConfiguration.name;
    }

    async login(returnException: boolean = true): Promise<void> {
        try {
            this.vaultClient = nv({
                endpoint: this.vaultConfiguration.endpoint,
                requestOptions: {
                    followAllRedirects: true,
                    strictSSL: true
                }
            });
            this.vaultClient.generateFunction('internalMounts', {
                method: 'GET',
                path: '/sys/internal/ui/mounts',
            });

            if (this.vaultConfiguration.auth.method === 'token') {
                this.vaultClient.token = this.vaultConfiguration.auth.token;
                const tokenLookupResult = await this.vaultClient.tokenLookupSelf();

                this.cacheVaultToken({
                    id: tokenLookupResult.data.id,
                    renewable: tokenLookupResult.data.renewable,
                    ttl: tokenLookupResult.data.ttl
                });

            } else if (this.vaultConfiguration.auth.method === 'username') {
                /* eslint-disable @typescript-eslint/naming-convention */
                const userpassLoginResult = await this.vaultClient.userpassLogin({
                    mount_point: this.vaultConfiguration.auth.mountPoint,
                    username: this.vaultConfiguration.auth.username,
                    password: this.vaultConfiguration.auth.password
                });
                /* eslint-enable @typescript-eslint/naming-convention */

                this.cacheVaultToken({
                    id: userpassLoginResult.auth.client_token,
                    renewable: userpassLoginResult.auth.renewable,
                    ttl: userpassLoginResult.auth.lease_duration
                });
            }
        } catch (err) {
            if (returnException) {
                throw err;
            } else {
                const message = typeof err === "string" ? err :
                    err instanceof Error ? err.message : 'unknown';
                vscode.window.showErrorMessage(`Login Vault Error: (${message})`);
            }
        }
    }

    async mounts(): Promise<model.VaultMount[]> {
        const _vaultClient: any = this.vaultClient;
        const mounts: any = await _vaultClient?.internalMounts();
        return Object.keys(mounts.data.secret)
            .filter(key => ['kv', 'cubbyhole'].includes(mounts.data.secret[key].type))
            .map(key => ({
                name: key.replace(/\/$/, ''),
                type: mounts.data.secret[key].type,
                version: mounts.data.secret[key].options?.version
            }));
    }

    async secrets(vaultMount: model.VaultMount): Promise<model.VaultSecret[]> {
        const path = vaultMount.type === 'kv' && vaultMount.version === '2' ?
            `${vaultMount.name}/metadata/`
            : vaultMount.name;

        const secrets: any = await this.vaultClient?.list(path).catch(err => {
            if (err?.response?.statusCode === 404) {
                return { data: { keys: [] } };
            } else {
                throw err;
            }
        });
        return secrets.data.keys.map((m: string) => ({
            name: m,
            mount: vaultMount
        }));
    }

    async data(vaultSecret: model.VaultSecret): Promise<model.VaultData[]> {
        const isKv2 = vaultSecret.mount.type === 'kv' && vaultSecret.mount.version === '2';

        const path = isKv2 ?
            `${vaultSecret.mount.name}/data/${vaultSecret.name}`
            : `${vaultSecret.mount.name}/${vaultSecret.name}`;

        const result: any = await this.vaultClient?.read(path).catch(err => {
            if (err?.response?.statusCode === 404) {
                return { data: { keys: [] } };
            } else {
                throw err;
            }
        });

        const flatten = (target: any): { [index: string]: string } => {
            const output: { [index: string]: string } = {};

            const transformKey = (key: string): string => {
                return key
                    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
                    .replace(/[^a-zA-Z0-9_]/g, '_')
                    .replace(/([a-z])([A-Z])/g, '$1_$2')
                    .trim()
                    .toUpperCase();
            };

            const transformValue = (value: any): any => {
                const type = Object.prototype.toString.call(value);
                if (type === '[object String]') {
                    return `"${value}"`;
                }

                return value;
            };

            const step = (object: any, prev?: string): void => {
                Object.keys(object).forEach((key) => {
                    const value = object[key];
                    const type = Object.prototype.toString.call(value);
                    const isobject = type === '[object Object]' || type === '[object Array]';

                    const newKey = prev ? prev + '_' + transformKey(key) : transformKey(key);

                    if (isobject && Object.keys(value).length) {
                        step(value, newKey);
                        return;
                    }

                    output[newKey] = transformValue(value);
                });
            };

            step(target);

            return output;
        };

        const flattened: any = flatten(isKv2 ? result.data.data : result.data);
        return Object.keys(flattened)
            .map(key => ({
                key,
                value: flattened[key]
            }))
            .sort((a, b) => a.key > b.key ? 1 : a.key < b.key ? -1 : 0);
   }

    private async renewToken(): Promise<void> {
        try {
            const tokenRenewResult = await this.vaultClient?.tokenRenewSelf();
            this.cacheVaultToken({
                id: tokenRenewResult.auth.client_token,
                renewable: tokenRenewResult.auth.renewable,
                ttl: tokenRenewResult.auth.lease_duration
            });
        } catch (err) {
            this.login(false);
        }
    }

    private cacheVaultToken(vaultToken: VaultToken): void {
        let action: string | null = null;
        let callback = () => {};
        let ms: number = 0;
        if (vaultToken.renewable === true) {
            action = 'renewal';
            callback = () => this.renewToken();
            ms = 900 * vaultToken.ttl;
        } else if (vaultToken.ttl > 0) {
            action = 'login';
            callback = () => this.login(false);
            ms = 1000 * vaultToken.ttl;
        }

        if (action) {
            this.tokenTimer = setTimeout(callback, ms);
        }
    }

    dispose(): any {
        this.tokenTimer && clearTimeout(this.tokenTimer);
        this.vaultClient && (this.vaultClient.token = '');
    }
}
