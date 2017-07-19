import { AppServiceRegistration, Cli, Bridge, Base, ThirdPartyAdapter } from 'matrix-appservice-bridge';

import { Puppet } from './puppet';
import { Config, Deduplication, IdentityPair, User } from './config';
import { BridgeController } from './bridge';
import * as fs  from 'async-file';
import * as npm from 'npm';

import * as tc from 'typed-promisify';

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
        reg.addRegexPattern("users", `^@[a-z]+_puppet_[\\w]+_[a-zA-Z0-9+\\/=]+:${this.config.homeserver.domain}$`, true);
        reg.addRegexPattern("aliases", `^#[a-z]+_puppet_[\\w]+_[a-zA-Z0-9+\\/=]+:${this.config.homeserver.domain}$`, true);
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
        for (let p in self.puppets) {
          self.puppets[p].handleMatrixEvent(req, context);
        }
      },
      onAliasQuery() {
        
      }
    };
  }

  private async run(port) : Promise<void> {
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
    
    // here we load all the puppets (don't start them yet, though)
    for (let u in this.config.users) {
      this.puppets[u] = new Puppet(u, this.config.users[u], this.config.homeserver);
    }
    
    // let's loop through all the networks
    for (let network in this.config.networks) {
      debug("Found network " + network);
      let net;
      // if we can't import the network then we'll try to install it!
      try {
        net = require('matrix-puppet-'+network);
      } catch (e) {
        await this.installNpmPackage('matrix-puppet-'+network);
        net = require('matrix-puppet-'+network);
      }
      if (!net.Adapter) { // uho, this is actually just some random thing...
        error("Network " + network + " doesn't export the 'Adapter' class!");
        process.exit(-1);
      }
      
      // okay let's loop through all identity pairs of this network and add them to the puppet
      let dedupe: Deduplication = this.config.networks[network].deduplication;
      for (let identId in this.config.networks[network].identityPairs) {
        let ident: IdentityPair = <IdentityPair>{
          id: identId,
          ...this.config.networks[network].identityPairs[identId]
        };
        if (!this.puppets[ident.matrixPuppet]) {
          error("Unkown matrix puppet " + ident.matrixPuppet);
          process.exit(-1);
        }
        this.puppets[ident.matrixPuppet].addAdapter(net.Adapter, ident, network, dedupe, this.bridge);
        debug(ident);
      }
      debug("Loaded network " + network);
    }
    
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
