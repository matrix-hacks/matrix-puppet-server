const info = require('debug')('matrix-puppet:info');
const warn = require('debug')('matrix-puppet:warn');
const error = require('debug')('matrix-puppet:error');

import { Bridge } from 'matrix-appservice-bridge';
import { Config } from './config';

export interface ThirdPartyLookup {
  protocols: Array<string>;
  getProtocol(): void;
  getLocation(): void;
  getUser(): void;
}

export interface BridgeController {
  onUserQuery(user: any): void;
  onEvent(req: object, context: object): void;
  onAliasQuery(): void;
}
