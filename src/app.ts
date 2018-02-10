import { AppServiceRegistration, Cli, Bridge, Base, ThirdPartyAdapter } from 'matrix-appservice-bridge';

import { Puppet } from './puppet';
import { Config, IdentityPair_Config, User } from './config';
import { BridgeController } from './bridge';
import * as fs  from 'async-file';
import * as npm from 'npm';
import { ghostCache } from './ghost-cache';
import * as sqlite3 from 'sqlite3';

const debug = require('debug')('matrix-puppet:debug');
const info = require('debug')('matrix-puppet:info');
const warn = require('debug')('matrix-puppet:warn');
const error = require('debug')('matrix-puppet:error');

export class App {
  private live : { [id: string]: Base };
  private config : Config;
  private bridge : Bridge;
  private configPath : string;
  private puppets : Map<string, Puppet> = new Map<string, Puppet>();
  public db;
  async readConfig(jsonFile: string) : Promise<Config> {
    const buffer : string = await fs.readFile(jsonFile);
    return <Config>JSON.parse(buffer);
  }

  async start(configPath: string) {
    this.configPath = configPath;
    this.config = await this.readConfig(configPath);
    this.live = {};
    
    new Cli({
      port: this.config.httpserver.port,
      registrationPath: this.config.homeserver.registration,
      generateRegistration: (reg, callback) => {
        reg.setId(AppServiceRegistration.generateToken());
        reg.setHomeserverToken(AppServiceRegistration.generateToken());
        reg.setAppServiceToken(AppServiceRegistration.generateToken());
        reg.setSenderLocalpart('puppetbot');
        reg.addRegexPattern("users", `^@_puppet_[\\w]+_[a-zA-Z0-9+\\/=_]+:${this.config.homeserver.domain}$`, true);
        reg.addRegexPattern("aliases", `^#_puppet_[\\w]+_[a-zA-Z0-9+\\/=_]+:${this.config.homeserver.domain}$`, true);
        callback(reg);
      },
      run: this.run.bind(this)
    }).run();
  }

  private async loadNpm() : Promise<void> {
    return new Promise<void>((resolve, reject) => {
      npm.load((err) => {
        if (err) {
          return reject(err);
        }
        return resolve();
      });
    });
  }

  private async installNpmPackage(pkg: string) : Promise<void> {
    return new Promise<void>((resolve, reject) => {
      npm.commands.install([pkg], (err, data) => {
        if (err) {
          npm.commands.link([pkg], (err, data) => {
            if (err) {
              return reject(err);
            }
            npm.commands.install([pkg], (err, data) => {
              if (err) {
                return reject(err);
              }
              return resolve(data);
            });
          });
        }
        return resolve(data);
      });
    });
  }

  private createBridgeController(): BridgeController {
    let self = this;
    return <BridgeController>{
      onUserQuery(user) {
        return {}; // auto provision users with no additional data
      },
      onEvent(req, context) {
        //debug("=========");
        //debug("NEW MATRIX EVENT");
        //debug(req);
        //debug(context);
        for (let p in self.puppets) {
          self.puppets[p].handleMatrixEvent(req, context);
        }
      },
      onAliasQuery() {
        
      }
    };
  }

  private async createDb() : Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.db = new sqlite3.Database('data.db');
      this.db.serialize(() => {
        this.db.run("CREATE TABLE IF NOT EXISTS users ( \
          id INTEGER PRIMARY KEY, \
          mxid TEXT NOT NULL, \
          token TEXT, \
          password TEXT \
        )");
        this.db.run("CREATE TABLE IF NOT EXISTS networks ( \
          id INTEGER PRIMARY KEY, \
          uid INTEGER NOT NULL, \
          type TEXT NOT NULL, \
          config TEXT NOT NULL, \
          FOREIGN KEY (uid) REFERENCES users (id) \
        )");
        this.db.run("CREATE TABLE IF NOT EXISTS ghosts ( \
          id INTEGER PRIMARY KEY, \
          mxid TEXT NOT NULL, \
          nid INTEGER NOT NULL, \
          remote TEXT NOT NULL, \
          name TEXT, \
          avatar TEXT, \
          FOREIGN KEY (nid) REFERENCES networks (id) \
        )");
        this.db.run("CREATE TABLE IF NOT EXISTS rooms ( \
          id INTEGER PRIMARY KEY, \
          mxid TEXT NOT NULL, \
          nid INTEGER NOT NULL, \
          remote TEXT NOT NULL, \
          direct INTEGER, \
          name TEXT, \
          topic TEXT, \
          icon TEXT, \
          FOREIGN KEY (nid) REFERENCES networks (id) \
        )");
      });
      this.db.runAsync = (s, p) => {
        return new Promise<void>((resolve, reject) => {
          this.db.run(s, p, (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          })
        });
      };
      this.db.getAsync = (s, p) => {
        if (!p) {
          p = [];
        }
        return new Promise<void>((resolve, reject) => {
          this.db.get(s, p, (err, row) => {
            if (err) {
              reject(err);
            } else {
              resolve(row);
            }
          })
        });
      };
      this.db.eachAsync = (s, p, c) => {
        if (!c) {
          c = p;
          p = [];
        }
        return new Promise<void>((resolve, reject) => {
          this.db.each(s, p, (err, row) => {
            if (err) {
              reject(err);
            } else {
              c(row);
            }
          }, (err, row) => {
            if (err) {
              reject(err);
            } else {
              resolve(row);
            }
          })
        });
      };
      resolve();
    });
  }

  private async run(port) : Promise<void> {
    await this.createDb();
    
    await ghostCache.load();
    let users : string[] = []; // this array holds all the usernames of valid people for easy lookup
    for (let u in this.config.users) {
      users.push(u);
    }
    await this.loadNpm();
    
    // first we create the bridge
    this.bridge = new Bridge({
      homeserverUrl: this.config.homeserver.url,
      domain: this.config.homeserver.domain,
      registration: this.config.homeserver.registration,
      controller: this.createBridgeController()
    });
    this.bridge.db = this.db;
    
    debug("========");
    // here we load all the puppets (don't start them yet, though)
    await this.db.eachAsync("SELECT id, mxid, token, password FROM users", (u) => {
      this.puppets[u.id] = new Puppet(u.mxid, <User>{password: u.password, token: u.token}, this.config.homeserver);
    });
    
    // let's loop through all the networks
    let networks = [];
    for (let nn in this.config.networks) {
      let n = this.config.networks[nn];
      debug("Found network " + n);
      let net;
      // if we can't import the network then we'll try to install it!
      try {
        net = require('matrix-puppet-'+n);
      } catch (e) {
        debug(e);
        await this.installNpmPackage('matrix-puppet-'+n);
        net = require('matrix-puppet-'+n);
      }
      if (!net.Adapter) { // uho, this is actually just some random thing...
        error("Network " + n + " doesn't export the 'Adapter' class!");
        process.exit(-1);
      }
      networks[n] = net;
    }
    await this.db.eachAsync("SELECT id, uid, type, config FROM networks", (n) => {
      if (!networks[n.type]) {
        error("Network " + n.type + " doesn't exist!");
        process.exit(-1);
      }
      if (!this.puppets[n.uid]) {
        error("User with uid " + n.uid + " doesn't exist!");
        process.exit(-1);
      }
      if (!n.config) {
        n.config = '{}';
      }
      this.puppets[n.uid].addAdapter(networks[n.type].Adapter, n.id, JSON.parse(n.config), this.bridge);
      debug("Loaded network " + n.id);
    });
    
    
    this.bridge.run(this.config.httpserver.port); // start the HTTP bridge
    
    // and now let's trigger the puppets to connect!
    for (let p in this.puppets) {
      let puppet = this.puppets[p];
      puppet.startClient(this.configPath).then(() => {
        puppet.startAdapters();
      });
    }
  }
}
