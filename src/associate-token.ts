import * as fs from 'async-file';
import * as matrixSdk from 'matrix-js-sdk';
import { Config, User } from './config';

async function read(args): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    require('read')(args, (err, s) => {
      if (err) {
        return reject(err);
      }
      resolve(s);
    });
  });
}

export interface TokenAssociationParams {
  localpart: string;
  jsonFile: string;
  token?: string;
}

async function updateToken(config: Config, params: TokenAssociationParams) {
  const { localpart, jsonFile, token } = params;
  if (!config.users[localpart]) {
    config.users[localpart] = <User>{};
  }
  config.users[localpart].token = token;
  return fs.writeFile(jsonFile, JSON.stringify(config, null, 2)).then(() => {
    console.log('Updated config file '+jsonFile);
  });
}


/**
 * Prompts user for credentials and updates the puppet section of the config
 *
 * @returns {Promise}
 */
export async function associateToken(params: TokenAssociationParams) {
  const { localpart, jsonFile } = params;
  const buffer : string = await fs.readFile(jsonFile);
  let config : Config = <Config>JSON.parse(buffer);
  if (params.token) {
    return updateToken(config, <TokenAssociationParams>{
      localpart,
      jsonFile,
      token: params.token
    });
  }
  const userId = "@" + localpart + ":" + config.homeserver.domain;
  console.log("Enter password for " + userId);
  const password = await read({silent: true, replace: '*'});
  const matrixClient = matrixSdk.createClient(config.homeserver.url);
  const accessDat = await matrixClient.loginWithPassword(userId, password);
  return updateToken(config, <TokenAssociationParams>{
    localpart,
    jsonFile,
    token: accessDat.access_token
  });
}
