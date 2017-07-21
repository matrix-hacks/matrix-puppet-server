import * as fs  from 'async-file';

interface GhostCacheInterface {
  name?: string;
  avatarUrl?: string;
  associatedNames?: string[];
  associatedAvatarUrls?: string[];
}

export class GhostCache {
  private filePath: string;
  private cache: Map<string, GhostCacheInterface> = new Map<string, GhostCacheInterface>();
  constructor(filePath: string) {
    this.filePath = filePath;
    
  }
  public load() : Promise<void> {
    return fs.readFile(this.filePath).catch((err) => {
      if (err.errno == -2) {
        return fs.writeFile(this.filePath, "{}").then(() => {
          return fs.readFile(this.filePath);
        });
      }
      return Promise.reject(err);
    }).then((buffer) => {
      this.cache = <Map<string, GhostCacheInterface>>JSON.parse(buffer);
      console.log(this.cache);
    });
  }
  private writeCache() : Promise<void> {
    return fs.writeFile(this.filePath, JSON.stringify(this.cache, null, 2));
  }
  private has(ghost: string, prop: string) : Promise<boolean> {
    if (!(ghost in this.cache)) {
      return Promise.resolve(false);
    }
    if (this.cache[prop]) {
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }
  private shouldUpdate(ghost: string, val: string, prop: string) : Promise<boolean> {
    if (!(ghost in this.cache)) {
      return Promise.resolve(true);
    }
    const g : GhostCacheInterface = this.cache[ghost];
    if (!g[prop] || g[prop] != val) {
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }
  private update(ghost: string, val: string, prop: string) : Promise<void> {
    return this.shouldUpdate(ghost, val, prop).then((should) => {
      if (!should) {
        return;
      }
      if (!(ghost in this.cache)) {
        this.cache[ghost] = <GhostCacheInterface>{};
      }
      this.cache[ghost][prop] = val;
      return this.writeCache();
    })
  }
  private associate(ghost: string, id: string, prop: string) : Promise<void> {
    if (!(ghost in this.cache)) {
      this.cache[ghost] = <GhostCacheInterface>{};
    }
    if (!this.cache[ghost][prop]) {
      this.cache[ghost][prop] = [];
    }
    if (this.cache[ghost][prop].indexOf(id) != -1) {
      return Promise.resolve(); // nothing to do!
    }
    this.cache[ghost][prop].push(id);
    return this.writeCache();
  }
  private getAssociated(ghost: string, prop: string) : Promise<string[]> {
    if (!(ghost in this.cache) || !this.cache[ghost] || !this.cache[ghost][prop]) {
      return Promise.resolve([]);
    }
    return Promise.resolve(this.cache[ghost][prop]);
  }
  public hasName(ghost: string) : Promise<boolean> {
    return this.has(ghost, 'name');
  }
  public shouldUpdateName(ghost: string, name: string) : Promise<boolean> {
    return this.shouldUpdate(ghost, name, 'name');
  }
  public updateName(ghost: string, name: string) : Promise<void> {
    return this.update(ghost, name, 'name');
  }
  public associateName(ghost: string, id: string) : Promise<void> {
    return this.associate(ghost, id, 'associatedNames');
  }
  public getAssociatedNames(ghost: string) : Promise<string[]> {
    return this.getAssociated(ghost, 'associatedNames');
  }
  public hasAvatarUrl(ghost: string) : Promise<boolean> {
    return this.has(ghost, 'avatarUrl');
  }
  public shouldUpdateAvatarUrl(ghost: string, url: string) : Promise<boolean> {
    return this.shouldUpdate(ghost, url, 'avatarUrl');
  }
  public updateAvatarUrl(ghost: string, url: string) : Promise<void> {
    return this.update(ghost, url, 'avatarUrl');
  }
  public associateAvatarUrl(ghost: string, id: string) : Promise<void> {
    return this.associate(ghost, id, 'associatedAvatarUrls');
  }
  public getAssociatedAvatarurls(ghost: string) : Promise<string[]> {
    return this.getAssociated(ghost, 'associatedAvatarUrls');
  }
}

export const ghostCache = new GhostCache('ghost_cache.json');
