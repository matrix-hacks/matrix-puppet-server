export interface IdentityPair_Config {
  // Short string to distinguishes this pair from others on the homeserver, used in alises and ghost ids.
  id?: string;

  // Credentials for the matrix user to puppet
  matrixPuppet: string;

  // Credentials for the third party network account to pair with the puppet
  thirdParty: any;
}

export interface Httpserver {
  port: number;
}

export interface Homeserver {
  domain: string;
  url: string;
  registration: string;
}

export interface User {
  password?: string;
  token?: string;
}

export interface Deduplication {
  tag: string;
  pattern: string;
}

export interface Network {
  deduplication?: Deduplication;
  identityPairs: Map<string, IdentityPair_Config>;
}

export interface Config {
  httpserver: Httpserver;
  homeserver: Homeserver;
  users: Map<string, User>;
  networks: Map<string, Network>;
}
