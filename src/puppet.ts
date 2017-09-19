const Promise = require('bluebird');
const matrixSdk = require("matrix-js-sdk");

import { MatrixClient } from './matrix-client';
import { IdentityPair } from './identity-pair';
import { Deduplication, Homeserver, User } from './config';
import { associateToken, TokenAssociationParams } from './associate-token';
import { Bridge } from 'matrix-appservice-bridge';
import { Base } from './base'

interface PuppetIdentity extends User {
  localpart: string;
}

/**
 * Puppet class
 */
export class Puppet {
  userId: string;
  client: MatrixClient;
  private homeserver: Homeserver;
  private identity: PuppetIdentity;
  
  private homeserverUrl: string;
  private bases: Base[];
  private matrixRoomMembers: any;

  /**
   * Constructs a Puppet
   */
  constructor(localpart: string, user: User, homeserver: Homeserver) {
    this.identity = <PuppetIdentity>{
      ...user,
      localpart
    };
    this.homeserver = homeserver;
    this.bases = [];
  }

  /**
   * creates a matrix client, connects, and waits for sync
   *
   * @returns {Promise} Returns a promise
   */
  public startClient(jsonFile?: string) {

    // load identity
    if ( this.identity ) {
      this.userId = "@"+this.identity.localpart+":"+this.homeserver.domain;
    } else {
      console.error('Invalid matrix identity specified');
      process.exit(1);
    }
    // end load identity

    // load token
    if (this.identity.token) {
      return this.login(this.identity.token);
    } else if (this.identity.password) {
      let matrixClient = matrixSdk.createClient(this.homeserver.url);
      return matrixClient.loginWithPassword(this.userId, this.identity.password).then(accessDat => {
        if (jsonFile) {
          return associateToken(<TokenAssociationParams>{
            localpart: this.identity.localpart,
            jsonFile,
            token: accessDat.access_token
          }).then(()=>{
            return this.login(accessDat.access_token);
          });
        } else {
          return this.login(accessDat.access_token);
        }
      });
    } else {
      console.error(`Matrix puppet '${this.identity.localpart}' must have a 'token' or 'password' to login`);
      process.exit(1);
    }
  }

  private login(token: string) : Promise<void> {
    this.client = matrixSdk.createClient({
      baseUrl: this.homeserver.url,
      userId: this.userId,
      accessToken: token
    })
    this.client.startClient();
    return new Promise((resolve, _reject) => {
      this.matrixRoomMembers = {};
      this.client.on("RoomState.members", (event, state, _member) => {
        this.matrixRoomMembers[state.roomId] = Object.keys(state.members);
      });

      this.client.on("Room.receipt", (event, room) => {
        let content = event.getContent();
        for (var eventId in content) {
          for (var userId in content[eventId]['m.read']) {
            if (userId === this.userId) {
              for (let b of this.bases) {
                return b.sendReadReceipt(room.roomId);
              }
            }
          }
        }
      });

      this.client.on('sync', (state) => {
        if ( state === 'PREPARED' ) {
          console.log('synced');
          resolve();
        }
      });
    });
  }

  public startAdapters() {
    for (let b of this.bases) {
      b.startClient();
    }
  }

  public handleMatrixEvent(req, _context) {
    for (let b of this.bases) {
      b.handleMatrixEvent(req, _context);
    }
  }

  public makeRoomAlias(s: string): string {
    return '#'+s+':'+this.homeserver.domain;
  }

  public makeUserAlias(s: string): string {
    return '@'+s+':'+this.homeserver.domain;
  }

  /**
   * Adds base and an adapter to that base
   */
  public addAdapter(
    adapterClass: any,
    ident: IdentityPair,
    network: string,
    dedupe: Deduplication,
    bridge: Bridge
  ) {
    let base = new Base(ident, network, this, bridge, adapterClass, dedupe);
    this.bases.push(base);
  }

  /**
   * Get the list of matrix room members
   *
   * @param {string} roomId matrix room id
   * @returns {Array} List of room members
   */
  private getMatrixRoomMembers(roomId) {
    return this.matrixRoomMembers[roomId] || [];
  }

  /**
   * Returns the MatrixClient
   *
   * @returns {MatrixClient} an instance of MatrixClient
   */
  public getClient() {
    return this.client;
  }
}
