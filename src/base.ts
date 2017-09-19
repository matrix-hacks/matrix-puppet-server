const debug = require('debug')('matrix-puppet:debug');
const info = require('debug')('matrix-puppet:info');
const warn = require('debug')('matrix-puppet:warn');
const error = require('debug')('matrix-puppet:error');
import { Bridge, RemoteUser } from 'matrix-appservice-bridge';
import { parse as urlParse} from 'url';
import { inspect } from 'util';
import * as path from 'path';
import { autoTagger, createUploader } from './utils';
import * as fs from 'async-file';

import { Puppet } from './puppet';
import { IdentityPair } from './identity-pair';
import { Deduplication } from './config';
import { BridgeController, ThirdPartyLookup } from './bridge';
import { Intent } from './intent';
import { MatrixClient } from './matrix-client';
import * as tp from 'typed-promisify';
import { entities } from 'matrix-puppet-bridge';
import { ghostCache } from './ghost-cache'

import {
  BangCommand, parseBangCommand,
  
  ThirdPartyAdapter,
  ThirdPartyMessagePayload,
  ThirdPartyImageMessagePayload,
  ContactListUserData,
  
  download, localdisk, isFilenameTagged,
  
  PuppetBridge,
  StatusMessageOptions,
  
  Image
} from 'matrix-puppet-bridge';


interface PrepareMessageHandlerParams {
  senderId: string;
  senderName: string;
  avatarUrl: string;
  roomId: string;
  text: string;
}

interface MessageHandler {
  tag(senderId: string): string;
  matrixRoomId: string;
  client: MatrixClient;
  ignore?: boolean;
}

interface NewMatrixRoomData {
  matrixRoomId: string;
  createdNeedName?: boolean;
  createdNeedAvatar?: boolean;
}

const a2b = a => {
  let buf = new Buffer(a);
  let encoded = '';
  for (let b of buf) {
    if (b == 0x5F) {
      // underscore
      encoded += '__';
    } else if ((b >= 0x61 && b <= 0x7A) || (b >= 0x30 && b <= 0x39)) {
      // [a-z0-9]
      encoded += String.fromCharCode(b);
    } else if (b >= 0x41 && b <= 0x5A) {
      encoded += '_' + String.fromCharCode(b + 0x20);
    } else if (b < 16) {
      encoded += '=0' + b.toString(16);
    } else {
      encoded += '=' + b.toString(16);
    }
  }
  return encoded;
}

const b2a = b => {
  let decoded = new Buffer(b.length);
  let j = 0;
  for (let i = 0; i < b.length; i++) {
    let char = b[i];
    if (char == '_') {
      i++;
      if (b[i] == '_') {
        decoded[j] = 0x5F;
      } else {
        decoded[j] = b[i].charCodeAt(0) - 0x20;
      }
    } else if (char == '=') {
      i++;
      decoded[j] = parseInt(b[i]+b[i+1], 16);
      i++;
    } else {
      decoded[j] = b[i].charCodeAt(0);
    }
    j++;
  }
  return decoded.toString('utf8', 0, j);
}

export class Base {
  public adapter: ThirdPartyAdapter;
  public bridge: Bridge;
  private identityPair: IdentityPair;
  private puppet: Puppet;
  private deduplicationTag: string;
  private deduplicationTagPattern: string;
  private deduplicationTagRegex: RegExp;
  private network: string;
  private thirdPartyRooms: Map<string, string> = new Map<string, string>();

  constructor(identityPair: IdentityPair, network: string, puppet: Puppet, bridge: Bridge, adapterClass: any, dedupe?: Deduplication) {
    this.identityPair = identityPair;
    this.puppet = puppet;
    this.network = network;
    
    this.deduplicationTag = (dedupe && dedupe.tag) || this.defaultDeduplicationTag();
    this.deduplicationTagPattern = (dedupe && dedupe.pattern) || this.defaultDeduplicationTagPattern();
    this.deduplicationTagRegex = new RegExp(this.deduplicationTagPattern);
    
    this.bridge = bridge;
    this.adapter = new adapterClass(identityPair.matrixPuppet, identityPair.thirdParty, <PuppetBridge>{
      newUsers: (a) => {
        return this.joinThirdPartyUsersToStatusRoom(a);
      },
      sendStatusMsg: (a, ...args) => {
        return this.sendStatusMsg(a, ...args);
      },
      sendImageMessage: (a) => {
        return this.handleThirdPartyRoomImageMessage(a);
      },
      sendMessage: (a) => {
        return this.handleThirdPartyRoomMessage(a);
      },
    });
    info('initialized bridge');
  }

  public startClient() {
    return this.adapter.initClient().then(() => {
      this.adapter.startClient();
    }).catch((err) => {
      console.log("Fatal error starting third party adapter");
      console.error(err);
      process.exit(-1);
    });
  }

  /**
   * Async call to get the status room ID
   *
   * @params {_roomAliasLocalPart} Optional, the room alias local part
   * @returns {Promise} Promise resolving the Matrix room ID of the status room
   */
  private getStatusRoomLocalpart(): string {
    return "status_puppet_room__"+a2b(this.puppet.userId)+"_";
  }
  private statusRoomId: string = '';
  private getStatusRoomId(_roomAliasLocalPart = '', force = false) {
    if (!force && this.statusRoomId) {
      return Promise.resolve(this.statusRoomId);
    }
    const roomAliasLocalPart = _roomAliasLocalPart || this.getStatusRoomLocalpart();
    const roomAlias = this.puppet.makeRoomAlias(roomAliasLocalPart);
    const puppetClient = this.puppet.getClient();

    const botIntent = this.getIntentFromApplicationServerBot();
    const botClient = botIntent.getClient();

    const puppetUserId = puppetClient.credentials.userId;

    const grantPuppetMaxPowerLevel = (room_id) => {
      info("ensuring puppet user has full power over this room");
      return botIntent.setPowerLevel(room_id, puppetUserId, 100).then(()=>{
        info('granted puppet client admin status on the protocol status room');
      }).catch((err)=>{
        warn(err);
        warn('ignoring failed attempt to give puppet client admin on the status room');
      }).then(()=> {
        return room_id;
      });
    };

    info('looking up', roomAlias);
    return puppetClient.getRoomIdForAlias(roomAlias).then(({room_id}) => {
      info("found matrix room via alias. room_id:", room_id);
      return grantPuppetMaxPowerLevel(room_id);
    }, (_err) => {
      const name = "Puppet Status Room";
      const topic = "Puppet Status Messages";
      info("creating status room !!!!", ">>>>"+roomAliasLocalPart+"<<<<", name, topic);
      return botIntent.createRoom({
        createAsClient: false,
        options: {
          name,
          topic,
          room_alias_name: roomAliasLocalPart
        }
      }).then(({room_id}) => {
        return this.puppet.client.setRoomTag(room_id, 'm.lowpriority', {}).then(() => {
          if (this.adapter.serviceIconPath) {
            return this.setRoomAvatarFromDisk(room_id, this.adapter.serviceIconPath).then(()=>room_id);
          }
          return room_id;
        }).catch(err => {
          error(err);
          return room_id;
        });
      });
    }).then(matrixRoomId => {
      info("making puppet join protocol status room", matrixRoomId);
      return puppetClient.joinRoom(matrixRoomId).then(() => {
        info("puppet joined the protocol status room");
        this.statusRoomId = matrixRoomId;
        return grantPuppetMaxPowerLevel(matrixRoomId);
      }, (err) => {
        if (err.message === 'No known servers') {
          warn('we cannot use this room anymore because you cannot currently rejoin an empty room (synapse limitation? riot throws this error too). we need to de-alias it now so a new room gets created that we can actually use.');
          return botClient.deleteAlias(roomAlias).then(()=>{
            warn('deleted alias... trying again to get or create room.');
            return this.getStatusRoomId(_roomAliasLocalPart, true);
          });
        } else {
          warn("ignoring error from puppet join room: ", err.message);
          return matrixRoomId;
        }
      });
    });
  }

  /**
   * Make a list of third party users join the status room
   *
   * @param {Object[]} users The list of third party users
   * @param {string} users[].name The third party user name
   * @param {string} users[].userId The third party user ID
   * @param {string} users[].avatarUrl The third party user avatar URL
   *
   * @returns {Promise} Promise resolving if all joins success
   */
  public joinThirdPartyUsersToStatusRoom(users: Array<ContactListUserData>) {
    info("Join %s users to the status room", users.length);
    return this.getStatusRoomId().then(statusRoomId => {
      return tp.map(users, (user) => {
        return this.getIntentFromThirdPartySenderId(a2b(user.userId), user.name, user.avatarUrl)
        .then((ghostIntent) => {
          return ghostIntent.join(statusRoomId);
        });
      });
    }).then(() => {
      info("Contact list synced");
    });
  }

  /**
   * Send a message to the status room
   *
   * @param {object} options={} Optional options object: fixedWidthOutput:boolean
   * @param {string} ...args additional arguments are formatted and send to the room
   *
   * @returns {Promise}
   */
  public sendStatusMsg(options: StatusMessageOptions, ...args) : Promise<void> {
    if (typeof options !== 'object') {
      throw new Error('sendStatusMsg requires first parameter to be an options object which can be empty.');
    }
    if (options.fixedWidthOutput === undefined)
    {
      options.fixedWidthOutput = true;
    }

    const msgText = args.reduce((acc, arg, index)=>{
      const sep = index > 0 ? ' ' : '';
      if (typeof arg === 'object') {
        return acc+sep+inspect(arg, {depth:null,showHidden:true});
      } else {
        return acc+sep+arg.toString();
      }
    }, '');

    info('sending status message', args);

    return this.getStatusRoomId(options.roomAliasLocalPart).then(statusRoomId => {
      var botIntent = this.bridge.getIntent();
      if (botIntent === null) {
        warn('cannot send a status message before the bridge is ready');
        return Promise.resolve();
      }
      let promiseList = [];

      promiseList.push(new Promise((resolve, reject) => {
        info("joining protocol bot to room >>>", statusRoomId, "<<<");
        return resolve(botIntent.join(statusRoomId));
      }));

      // AS Bots don't have display names? Weird...
      // PUT https://<REDACTED>/_matrix/client/r0/profile/%40hangoutsbot%3Aexample.org/displayname (AS) HTTP 404 Error: {"errcode":"M_UNKNOWN","error":"No row found"}
      //promiseList.push(() => botIntent.setDisplayName(this.getServiceName() + " Bot"));

      promiseList.push(new Promise((resolve, reject) => {
        let txt = this.tagMatrixMessage(msgText); // <-- Important! Or we will cause message looping...
        if(options.fixedWidthOutput)
        {
          return resolve(botIntent.sendMessage(statusRoomId, {
            body: txt,
            formatted_body: "<pre><code>" + entities.encode(txt) + "</code></pre>",
            format: "org.matrix.custom.html",
            msgtype: "m.notice"
          }));
        }
        else
        {
          return resolve(botIntent.sendMessage(statusRoomId, {
            body: txt,
            msgtype: "m.notice"
          }));
        }
      }));

      return Promise.all(promiseList);
    }).then(() => {
      return; // make sure we return Promise<void>
    });
  }

  private getGhostUserFromThirdPartySenderId(id) {
    return this.puppet.makeUserAlias(this.getRoomAliasLocalPartFromThirdPartyRoomId(id));
  }

  private getRoomAliasFromThirdPartyRoomId(id) {
    return this.puppet.makeRoomAlias(this.getRoomAliasLocalPartFromThirdPartyRoomId(id));
  }

  private getThirdPartyRoomIdFromMatrixRoomId(matrixRoomId) {
    const patt = new RegExp(`^#${this.network}_puppet_${this.identityPair.id}_([a-zA-Z0-9+\\/=_]+)$`);
    const room = this.puppet.getClient().getRoom(matrixRoomId);
    info('reducing array of alases to a 3prid');
    debug(room.getAliases());
    debug(`^#${this.network}_puppet_${this.identityPair.id}_([a-zA-Z0-9+\\/=_]+)$`);
    let status = '#'+this.getStatusRoomLocalpart();
    return room.getAliases().reduce((result, alias) => {
      debug(alias);
      const localpart = alias.split(':')[0];
      if (localpart == status) {
        return 'status_room';
      }
      const matches = localpart.match(patt);
      return matches ? matches[1] : result;
    }, null);
  }
  private getRoomAliasLocalPartFromThirdPartyRoomId(id) {
    return this.network+"_puppet_"+this.identityPair.id+"_"+id;
  }

  /**
   * Get a intent for a third party user, and if provided set its display name and its avatar
   *
   * @param {string} userId The third party user ID
   * @param {string} name The third party user name
   * @param {string} avatarUrl The third party user avatar URL
   * @param {matrixRoomData} optional room data to associate with this ghost (for e.g. room avatar changing along)
   *
   * @returns {Promise} A promise resolving to an Intent
   */

  private getIntentFromThirdPartySenderId(userId: string, name?: string, avatarUrl?: string, matrixRoomData?: NewMatrixRoomData) : Promise<Intent> {
    const ghostUserId = this.getGhostUserFromThirdPartySenderId(userId);
    const ghostIntent = this.bridge.getIntent(ghostUserId);
    const botClient = this.getIntentFromApplicationServerBot().getClient();
    // TODO: cache name & avatarUrl of ghost locally

    let promiseList = [];
    
    if (matrixRoomData && matrixRoomData.matrixRoomId) {
      if (matrixRoomData.createdNeedName) {
        promiseList.push(ghostCache.associateName(ghostUserId, matrixRoomData.matrixRoomId));
      }
      if (matrixRoomData.createdNeedAvatar) {
        promiseList.push(ghostCache.associateAvatarUrl(ghostUserId, matrixRoomData.matrixRoomId));
      }
    }
    
    let updatenamePromise = (should: boolean, _name: string) => {
      if (should) {
        info("Updating display name for", ghostUserId);
        return ghostIntent.setDisplayName(_name).then(() => {
          return ghostCache.updateName(ghostUserId, _name);
        }).then(() => {
          return ghostCache.getAssociatedNames(ghostUserId);
        }).then((matrixRoomIds) => {
          let namePromiseList = [];
          matrixRoomIds.forEach((roomId) => {
            namePromiseList.push(botClient.setRoomName(roomId, _name));
          });
          return Promise.all(namePromiseList);
        });
      } else if (matrixRoomData && matrixRoomData.matrixRoomId && matrixRoomData.createdNeedName) {
        return botClient.setRoomName(matrixRoomData.matrixRoomId, _name);
      }
      return Promise.resolve();
    };
    if (name) {
      promiseList.push(ghostCache.shouldUpdateName(ghostUserId, name).then((should) => {
        return updatenamePromise(should, name);
      }));
    } else {
      promiseList.push(ghostCache.hasName(ghostUserId).then((has) => {
        if (has) {
          return;
        }
        return this.getOrInitRemoteUserStoreDataFromThirdPartyUserId(userId).then((remoteUser)=>{
          let _name = remoteUser.get('name');
          return ghostCache.shouldUpdateName(ghostUserId, _name).then((should) => {
            return updatenamePromise(should, _name);
          })
        });
      }));
    }

    let updateavatarPromise = (should: boolean, _url: string) => {
      if (should) {
        info("Updating avatar for", ghostUserId);
        let contentUri = '';
        return this.setGhostAvatar(ghostIntent, _url).then((avatar_url) => {
          if (!avatar_url) {
            return Promise.reject(new Error("Couldn't upload avatar!"));
          }
          contentUri = avatar_url;
          // TODO: set private room name avatars
          return ghostCache.updateAvatarUrl(ghostUserId, _url);
        }).then(() => {
          return ghostCache.getAssociatedAvatarurls(ghostUserId);
        }).then((matrixRoomIds) => {
          let avatarPromiseList = [];
          debug(contentUri);
          matrixRoomIds.forEach((roomId) => {
            avatarPromiseList.push(botClient.sendStateEvent(roomId, 'm.room.avatar', { url: contentUri }, ''));
          });
          return Promise.all(avatarPromiseList);
        }).then(() => {
          return; // make sure we are <Promise<void>>
        });
      } else if (matrixRoomData && matrixRoomData.matrixRoomId && matrixRoomData.createdNeedAvatar) {
        return ghostIntent.getClient().getProfileInfo(ghostUserId, 'avatar_url').then(({avatar_url})=>{
          if (avatar_url) {
            return botClient.sendStateEvent(matrixRoomData.matrixRoomId, 'm.room.avatar', { url: avatar_url }, '');
          }
        });
      }
      return Promise.resolve();
    }
    if (avatarUrl) { // this.setGhostAvatar(ghostIntent, avatarUrl)
      promiseList.push(ghostCache.shouldUpdateAvatarUrl(ghostUserId, avatarUrl).then((should) => {
        return updateavatarPromise(should, avatarUrl);
      }));
    } else {
      promiseList.push(ghostCache.hasAvatarUrl(ghostUserId).then((has) => {
        if (has) {
          return;
        }
        return this.getOrInitRemoteUserStoreDataFromThirdPartyUserId(userId).then((remoteUser)=>{
          let _url = remoteUser.get('avatarUrl');
          return ghostCache.shouldUpdateAvatarUrl(ghostUserId, _url).then((should) => {
            return updateavatarPromise(should, _url);
          })
        });
      }));
    }

    return Promise.all(promiseList).then(() => {
      return ghostIntent;
    });
  }

  private getIntentFromApplicationServerBot() : Intent {
    return this.bridge.getIntent();
  }

  /**
   * Returns a Promise resolving {senderName}
   *
   * Optional code path which is only called if the adapter does not
   * provide a senderName when invoking handleThirdPartyRoomMessage
   *
   * @param {string} thirdPartyUserId
   * @returns {Promise} A promise resolving to a {RemoteUser}
   */

  private getOrInitRemoteUserStoreDataFromThirdPartyUserId(thirdPartyUserId: string) : Promise<RemoteUser> {
    const userStore = this.bridge.getUserStore();
    return userStore.getRemoteUser(thirdPartyUserId).then(rUser=>{
      if ( rUser ) {
        info("found existing remote user in store", rUser);
        return rUser;
      } else {
        info("did not find existing remote user in store, we must create it now");
        return this.adapter.getUserData(b2a(thirdPartyUserId)).then(thirdPartyUserData => {
          info("got 3p user data:", thirdPartyUserData);
          return new RemoteUser(thirdPartyUserId, thirdPartyUserData);
        }).then(rUser => {
          return userStore.setRemoteUser(rUser);
        }).then(()=>{
          return userStore.getRemoteUser(thirdPartyUserId);
        }).then(rUser => {
          return rUser;
        });
      }
    });
  }

  private getOrCreateMatrixRoomFromThirdPartyRoomId(thirdPartyRoomId: string, force = false, ghostId?: string) : Promise<NewMatrixRoomData> {
    if (!force && (thirdPartyRoomId in this.thirdPartyRooms)) {
      return new Promise<NewMatrixRoomData>((resolve, reject) => {
        resolve(<NewMatrixRoomData>{
          matrixRoomId: this.thirdPartyRooms[thirdPartyRoomId],
        });
      })
    }
    const roomAlias = this.getRoomAliasFromThirdPartyRoomId(thirdPartyRoomId);
    const roomAliasName = this.getRoomAliasLocalPartFromThirdPartyRoomId(thirdPartyRoomId);
    info('looking up', thirdPartyRoomId, '('+roomAlias+')');
    const puppetClient = this.puppet.getClient();
    const botIntent = this.getIntentFromApplicationServerBot();
    const botClient = botIntent.getClient();
    const puppetUserId = puppetClient.credentials.userId;
    let ghostIntent: Intent = null;
    if (ghostId) {
      ghostId = this.getGhostUserFromThirdPartySenderId(ghostId)
      ghostIntent = this.bridge.getIntent(ghostId);
    }

    const grantPuppetMaxPowerLevel = (room_id) => {
      info("ensuring puppet user has full power over this room");
      return botIntent.setPowerLevel(room_id, puppetUserId, 100).then(()=>{
        info('granted puppet client admin status on the protocol status room');
      }).catch((err)=>{
        warn(err);
        warn('ignoring failed attempt to give puppet client admin on the status room');
      }).then(()=> {
        return room_id;
      });
    };
    
    const makeDirect = (room_id, userId = "") => {
      // taken from https://github.com/matrix-org/matrix-react-sdk/blob/a5aa497287ec9a8d7536f14657bbee9406ebc6fa/src/Rooms.js#L103
      const mDirectEvent = puppetClient.getAccountData('m.direct');
      let dmRoomMap = {};
      
      if (mDirectEvent !== undefined) {
        dmRoomMap = mDirectEvent.getContent();
      }
      
      // remove it from the lists of any others users
      // (it can only be a DM room for one person)
      for (const thisUserId of Object.keys(dmRoomMap)) {
        const roomList = dmRoomMap[thisUserId];

        if (thisUserId != userId) {
          const indexOfRoom = roomList.indexOf(room_id);
          if (indexOfRoom > -1) {
            roomList.splice(indexOfRoom, 1);
          }
        }
      }
      
      const roomList = dmRoomMap[userId] || [];
      if (roomList.indexOf(room_id) == -1) {
        roomList.push(room_id);
      }
      dmRoomMap[userId] = roomList;
      
      return puppetClient.setAccountData('m.direct', dmRoomMap).then(() => room_id);
    }
    
    let _createdNeedName = false;
    let _createdNeedAvatar = false;
    
    return puppetClient.getRoomIdForAlias(roomAlias).then(({room_id}) => {
      info("found matrix room via alias. room_id:", room_id);
      return room_id;
    }, (_err) => {
      info("the room doesn't exist. we need to create it for the first time");
      return Promise.resolve(this.adapter.getRoomData(b2a(thirdPartyRoomId))).then(thirdPartyRoomData => {
        info("got 3p room data", thirdPartyRoomData);
        const { name, topic, avatarUrl, isDirect } = thirdPartyRoomData;
        info("creating room !!!!", ">>>>"+roomAliasName+"<<<<", name, topic);
        if (!name) {
          _createdNeedName = true;
        }
        if (!avatarUrl) {
          _createdNeedAvatar = true;
        }
        // it seems we will run into M_EXCLUSIVE even with a ghost intent...
        // we are forced to use the bot intent to create the room :(
        // this would be fine is createAsClient was honored -- but it is not honored...
        // we will force the bot to leave later
        let inviteArray = [];
        if (ghostIntent) {
          inviteArray.push(ghostId);
        }
        inviteArray.push(puppetUserId);
        
        debug(inviteArray);
        return botClient.createRoom({
            name,
            topic,
            visibility: 'private',
            invite: inviteArray
        }).then(({room_id}) => {
          info("room created", room_id);
          let promiseList = [];
          promiseList.push(botIntent.createAlias(roomAlias, room_id));
          
          if (ghostIntent) {
            promiseList.push(ghostIntent.getClient().joinRoom(room_id));
            promiseList.push(botClient.setPowerLevel(room_id, ghostId, 100).catch(err => {
              warn('Failed to make ghost an admin');
            }));
          }
          
          promiseList.push(puppetClient.joinRoom(room_id));
          promiseList.push(botClient.setPowerLevel(room_id, puppetUserId, 100).catch(err => {
            warn('Failed to make ourself an admin');
          }));
          
          if (avatarUrl) {
            promiseList.push(this.setRoomAvatar(room_id, avatarUrl).then(()=>room_id));
          }

          if (isDirect) {
            if (ghostIntent) {
              promiseList.push(makeDirect(room_id, ghostId));
            } else {
              promiseList.push(makeDirect(room_id, roomAlias));
            }
          }

          return Promise.all(promiseList).then(()=>room_id);
        });
      });
    }).then(matrixRoomId => {
      // we still do this to verify if the puppet is in the room
      // if the puppet isn't in the room then we need to abort it as we lost control over it
      info("making puppet join room", matrixRoomId);
      return puppetClient.joinRoom(matrixRoomId).then(()=>{
        info("returning room id after join room attempt", matrixRoomId);
        return matrixRoomId;
      }, (err) => {
        if ( err.message === 'No known servers' ) {
          warn('we cannot use this room anymore because you cannot currently rejoin an empty room (synapse limitation? riot throws this error too). we need to de-alias it now so a new room gets created that we can actually use.');
          return botClient.deleteAlias(roomAlias).then(()=>{
            warn('deleted alias... trying again to get or create room.');
            return this.getOrCreateMatrixRoomFromThirdPartyRoomId(thirdPartyRoomId, true).then(({ matrixRoomId, createdNeedName, createdNeedAvatar }) => {
              _createdNeedName = createdNeedName;
              _createdNeedAvatar = createdNeedAvatar;
              return matrixRoomId;
            });
          });
        } else {
          warn("ignoring error from puppet join room: ", err.message);
          return matrixRoomId;
        }
      });
    }).then(matrixRoomId => {
      // the naming scheme is significantly different, we would never collide so we might as well use the same map for both directions
      this.thirdPartyRooms[matrixRoomId] = thirdPartyRoomId;
      this.thirdPartyRooms[thirdPartyRoomId] = matrixRoomId;
      
      return <NewMatrixRoomData>{
        matrixRoomId,
        createdNeedName: _createdNeedName,
        createdNeedAvatar: _createdNeedAvatar,
      };
    });
  }

  private roomGhostMap:Map<string, string[]> = new Map<string, string[]>();
  private inviteAndJoinMatrixRoom(ghostIntent, roomId: string, force = false): Promise<void> {
    const botIntent = this.getIntentFromApplicationServerBot();
    const botClient = botIntent.getClient();
    
    const ghostId = ghostIntent.getClient().credentials.userId;
    if (!force && (roomId in this.roomGhostMap) && this.roomGhostMap[roomId].indexOf(ghostId) !== -1) {
      return Promise.resolve();
    }
    
    const joinPromise = ghostIntent.join(roomId).then(() => {
      if (!(roomId in this.roomGhostMap)) {
        this.roomGhostMap[roomId] = [];
      }
      this.roomGhostMap[roomId].push(ghostId);
    }).then(() => {
      return botClient.setPowerLevel(roomId, ghostId, 100).then(() => {
        info('granted ghost max power level');
      }).catch((err) => {
        warn(err);
        warn('Ignorning granting ghost power');
      });
    });
    return botClient.invite(roomId, ghostId).then(() => {
      return joinPromise;
    }).catch(err => {
      if (err.name == 'M_FORBIDDEN') {
        return joinPromise;
      }
      return this.sendStatusMsg({}, err);
    });
  }

  private prepareMessageHandler(params : PrepareMessageHandlerParams, force = false) : Promise<MessageHandler> {
    const { text, senderId, senderName, avatarUrl, roomId } = params;
    const tag = autoTagger(senderId, this);


    return this.getOrCreateMatrixRoomFromThirdPartyRoomId(roomId, force, senderId).then((matrixRoomData) => {
      const { matrixRoomId, createdNeedName, createdNeedAvatar } = matrixRoomData;
      if (senderId === undefined) {
        let handler : MessageHandler = { tag, matrixRoomId, client: this.puppet.client }
        if ( this.isTaggedMatrixMessage(text) ) {
          handler.ignore = true;
        }
        return handler;
      }
      return this.getIntentFromThirdPartySenderId(senderId, senderName, avatarUrl, matrixRoomData).then(ghostIntent=>{
        return this.getStatusRoomId().then((statusRoomId)=>{
          return ghostIntent.join(statusRoomId);
        }).then(()=>{
          return this.inviteAndJoinMatrixRoom(ghostIntent, matrixRoomId, force).then(()=>{
            let handler : MessageHandler = { tag, matrixRoomId, client: ghostIntent.getClient() };
            return handler;
          });
        });
      });
    });
  }

  private prepareAndSendMessageHandler(prep: PrepareMessageHandlerParams, sendMessage) : Promise<void> {
    return this.prepareMessageHandler(prep)
      .then(sendMessage)
      .catch(err=> {
        warn("Couldn't prepare message handler, forcing new state...");
        error(err);
        return this.prepareMessageHandler(prep, true).then(sendMessage);
      })
      .then(() => {
        return; // make the promise <void>
      });
  }

  /**
   * Returns a promise
   */
  public handleThirdPartyRoomImageMessage(payload: ThirdPartyImageMessagePayload) : Promise<void> {
    info('handling third party room image message', payload);
    if (payload.senderId) {
      if (!payload.senderName) {
        payload.senderName = payload.senderId;
      }
      payload.senderId = a2b(payload.senderId);
    }
    payload.roomId = a2b(payload.roomId);
    let {
      text, senderId, senderName, avatarUrl, roomId,
      url, path, buffer, // either one is fine
      h,
      w,
      mimetype
    } = payload;

    const prep : PrepareMessageHandlerParams = {
      text, senderId, senderName, avatarUrl, roomId
    };
    
    const sendMessage = (handler) => {
      if (handler.ignore) return;
      const { tag, matrixRoomId, client } = handler;
      const { upload } = createUploader(client, text, mimetype);

      let promise;
      if ( url ) {
        promise = ()=> {
          return download.getBufferAndType(url).then(({buffer,type}) => {
            return upload(buffer, { type: mimetype || type });
          });
        };
      } else if ( path ) {
        promise = fs.readFile(path).then(() => {
          return upload(buffer);
        });
      } else if ( buffer ) {
        promise = () => upload(buffer);
      } else {
        promise = Promise.reject(new Error('missing url or path'));
      }

      promise().then(({ content_uri, size }) => {
        info('uploaded to', content_uri);
        let msg = tag(text);
        let opts = { mimetype, h, w, size };
        return client.sendImageMessage(matrixRoomId, content_uri, opts, msg);
      }, (err) =>{
        warn('upload error', err);

        let opts = {
          body: tag(url || path || text),
          msgtype: "m.text"
        };
        return client.sendMessage(matrixRoomId, opts);
      });
    };

    return this.prepareAndSendMessageHandler(prep, sendMessage);
  }
  /**
   * Returns a promise
   */
  public handleThirdPartyRoomMessage(payload : ThirdPartyMessagePayload) : Promise<void> {
    info('handling third party room message', payload);
    if (payload.senderId) {
      payload.senderId = a2b(payload.senderId);
      if (!payload.senderName) {
        payload.senderName = payload.senderId;
      }
    }
    payload.roomId = a2b(payload.roomId);
    debug(payload);
    const {
      text, senderId, senderName, avatarUrl, roomId,
      html
    } = payload;
    const prep : PrepareMessageHandlerParams = {
      text, senderId, senderName, avatarUrl, roomId
    }
    
    const sendMessage = (handler) => {
      if (handler.ignore) return;
      const { tag, matrixRoomId, client } = handler;
      if (html) {
        return client.sendMessage(matrixRoomId, {
          body: tag(text),
          formatted_body: html,
          format: "org.matrix.custom.html",
          msgtype: "m.text"
        });
      } else {
        return client.sendMessage(matrixRoomId, {
          body: tag(text),
          msgtype: "m.text"
        });
      }
    };
    return this.prepareAndSendMessageHandler(prep, sendMessage);
  }

  public handleMatrixEvent(req, _context) {
    const data = req.getData();
    if (data.type === 'm.room.message') {
      info('incoming message. data:', data);
      return this.handleMatrixMessageEvent(data);
    } else {
      return warn('ignored a matrix event', data.type);
    }
  }

  private handleMatrixMessageEvent(data) {
    const { room_id, sender, content: { body, msgtype } } = data;

    let promise, msg;

    if (this.puppet.userId != sender || this.isTaggedMatrixMessage(body)) {
      info("ignoring tagged message, it was sent by the bridge");
      return;
    }

    const thirdPartyRoomId = this.getThirdPartyRoomIdFromMatrixRoomId(room_id);
    const isStatusRoom = thirdPartyRoomId === "status_room";
    debug(thirdPartyRoomId);
    if (!thirdPartyRoomId) {
      promise = () => Promise.resolve(); // not our network prefix
    } else if (isStatusRoom) {
      info("ignoring incoming message to status room");

      msg = this.tagMatrixMessage("Commands are currently ignored here");

      // We may wish to process bang commands here at some point,
      // but for now let's just send a message back
      promise = () => this.sendStatusMsg({ fixedWidthOutput: false }, msg);

    } else {
      msg = this.tagMatrixMessage(body);

      if (msgtype === 'm.text') {
        if (this.adapter.handleMatrixUserBangCommand) {
          const bc = parseBangCommand(body);
          if (bc) return this.adapter.handleMatrixUserBangCommand(bc, data);
        }
        promise = () => this.adapter.sendMessage(b2a(thirdPartyRoomId), msg);
      } else if (msgtype === 'm.image') {
        info("picture message from riot");

        let url = this.puppet.getClient().mxcUrlToHttp(data.content.url);
        promise = () => {
          const image : Image = {
            url, text: this.tagMatrixMessage(body),
            mimetype: data.content.info.mimetype,
            width: data.content.info.w,
            height: data.content.info.h,
            size: data.content.info.size,
          }
          return this.adapter.sendImageMessage(b2a(thirdPartyRoomId), image);
        };
      } else if (msgtype === 'm.emote') {
        promise = () => this.adapter.sendEmoteMessage(b2a(thirdPartyRoomId), msg);
      } else {
        let err = 'dont know how to handle this msgtype '+msgtype;
        promise = () => Promise.reject(new Error(err));
      }
    }

    return promise().catch(err=>{
      this.sendStatusMsg({}, err, data);
    });
  }

  private defaultDeduplicationTag() {
    return " \ufeff";
  }
  private defaultDeduplicationTagPattern() {
    return " \\ufeff$";
  }
  private tagMatrixMessage(text) {
    return text+this.deduplicationTag;
  }
  private isTaggedMatrixMessage(text) {
    return this.deduplicationTagRegex.test(text);
  }
  /**
   * Sets the ghost avatar using a regular URL
   * Will check to see if an existing avatar exists, and if so,
   * will not bother downloading from URL, uploading to media store,
   * and setting in the ghost user profile. Why? I do not know if
   * this is the same image or a different one, and without such
   * information, we'd constantly be running this whole routine
   * for the same exact image.
   *
   * @param {Intent} ghostIntent represents the ghost user
   * @param {string} avatarUrl a resource on the public web
   * @returns {Promise}
   */

  private setGhostAvatar(ghostIntent, avatarUrl) : Promise<string> {
    const client = ghostIntent.getClient();
    info('downloading avatar from public web', avatarUrl);
    return download.getBufferAndType(avatarUrl).then(({buffer, type})=> {
      let opts = {
        name: path.basename(avatarUrl),
        type,
        rawResponse: false
      };
      return client.uploadContent(buffer, opts);
    }).then((res)=>{
      const contentUri = res.content_uri;
      info('uploaded avatar and got back content uri', contentUri);
      return ghostIntent.setAvatarUrl(contentUri).then(() => {
        return contentUri;
      });
    });
  }

  private setRoomAvatar(roomId: string, avatarUrl: string) {
    const botIntent = this.getIntentFromApplicationServerBot();
    const client = botIntent.getClient();

    return download.getBufferAndType(avatarUrl).then(({buffer, type})=> {
      let opts = {
        name: path.basename(avatarUrl),
        type,
        rawResponse: false
      };
      return client.uploadContent(buffer, opts);
    }).then((res)=>{
      const contentUri = res.content_uri;
      info('uploaded avatar and got back content uri', contentUri);
      return botIntent.setRoomAvatar(roomId, contentUri);
    });
  }

  private setRoomAvatarFromDisk(roomId: string, avatarPath: string) {
    const botIntent = this.getIntentFromApplicationServerBot();
    const client = botIntent.getClient();

    return localdisk.getBufferAndType(avatarPath).then(({buffer, type})=> {
      let opts = {
        name: path.basename(avatarPath),
        type,
        rawResponse: false
      };
      return client.uploadContent(buffer, opts);
    }).then((res)=>{
      const contentUri = res.content_uri;
      info('uploaded avatar and got back content uri', contentUri);
      return botIntent.setRoomAvatar(roomId, contentUri);
    });
  }

  public sendReadReceipt(roomId: string) {
    if (roomId in this.thirdPartyRooms) {
      return this.adapter.sendReadReceipt(b2a(this.thirdPartyRooms[roomId]));
    }
  }
}
