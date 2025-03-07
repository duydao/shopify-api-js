import {RestResourceError} from '../lib/error';
import {Session} from '../lib/session/session';
import {RestRequestReturn} from '../lib/clients/rest/types';
import {DataType, GetRequestParams} from '../lib/clients/http_client/types';
import {RestClient} from '../lib/clients/rest/rest_client';
import {ApiVersion} from '../lib/types';
import {ConfigInterface} from '../lib/base-types';

import {IdSet, Body, ResourcePath, ParamSet} from './types';

interface BaseFindArgs {
  session: Session;
  params?: ParamSet;
  urlIds: IdSet;
}

interface BaseConstructorArgs {
  session: Session;
  fromData?: Body | null;
}

interface SaveArgs {
  update?: boolean;
}

interface RequestArgs extends BaseFindArgs {
  http_method: string;
  operation: string;
  body?: Body | null;
  entity?: Base | null;
}

interface GetPathArgs {
  http_method: string;
  operation: string;
  urlIds: IdSet;
  entity?: Base | null;
}

interface SetClassPropertiesArgs {
  CLIENT: typeof RestClient;
  CONFIG: ConfigInterface;
}

export class Base {
  // For instance attributes
  [key: string]: any;

  public static NEXT_PAGE_INFO: GetRequestParams | undefined;
  public static PREV_PAGE_INFO: GetRequestParams | undefined;

  public static CLIENT: typeof RestClient;
  public static CONFIG: ConfigInterface;

  public static API_VERSION: string;
  protected static NAME = '';
  protected static PLURAL_NAME = '';
  protected static PRIMARY_KEY = 'id';
  protected static CUSTOM_PREFIX: string | null = null;
  protected static READ_ONLY_ATTRIBUTES: string[] = [];

  protected static HAS_ONE: {[attribute: string]: typeof Base} = {};
  protected static HAS_MANY: {[attribute: string]: typeof Base} = {};

  protected static PATHS: ResourcePath[] = [];

  public static setClassProperties({CLIENT, CONFIG}: SetClassPropertiesArgs) {
    this.CLIENT = CLIENT;
    this.CONFIG = CONFIG;
  }

  protected static async baseFind<T extends Base = Base>({
    session,
    urlIds,
    params,
  }: BaseFindArgs): Promise<T[]> {
    const response = await this.request<T>({
      http_method: 'get',
      operation: 'get',
      session,
      urlIds,
      params,
    });

    this.NEXT_PAGE_INFO = response.pageInfo?.nextPage ?? undefined;
    this.PREV_PAGE_INFO = response.pageInfo?.prevPage ?? undefined;

    return this.createInstancesFromResponse<T>(session, response.body as Body);
  }

  protected static async request<T = unknown>({
    session,
    http_method,
    operation,
    urlIds,
    params,
    body,
    entity,
  }: RequestArgs): Promise<RestRequestReturn<T>> {
    const client = new this.CLIENT({
      session,
      apiVersion: this.API_VERSION as ApiVersion,
    });

    const path = this.getPath({http_method, operation, urlIds, entity});

    const cleanParams: {[key: string]: string | number} = {};
    if (params) {
      for (const key in params) {
        if (params[key] !== null) {
          cleanParams[key] = params[key];
        }
      }
    }

    switch (http_method) {
      case 'get':
        return client.get<T>({path, query: cleanParams});
      case 'post':
        return client.post<T>({
          path,
          query: cleanParams,
          data: body!,
          type: DataType.JSON,
        });
      case 'put':
        return client.put<T>({
          path,
          query: cleanParams,
          data: body!,
          type: DataType.JSON,
        });
      case 'delete':
        return client.delete<T>({path, query: cleanParams});
      default:
        throw new Error(`Unrecognized HTTP method "${http_method}"`);
    }
  }

  protected static getJsonBodyName(): string {
    return this.name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  }

  protected static getPath({
    http_method,
    operation,
    urlIds,
    entity,
  }: GetPathArgs): string {
    let match: string | null = null;
    let specificity = -1;

    this.PATHS.forEach((path: ResourcePath) => {
      if (
        http_method !== path.http_method ||
        operation !== path.operation ||
        path.ids.length <= specificity
      ) {
        return;
      }

      let pathUrlIds: IdSet = {...urlIds};
      path.ids.forEach((id) => {
        if (!pathUrlIds[id] && entity && entity[id]) {
          pathUrlIds[id] = entity[id];
        }
      });

      pathUrlIds = Object.entries(pathUrlIds).reduce(
        (acc: IdSet, [key, value]: [string, string | number | null]) => {
          if (value) {
            acc[key] = value;
          }
          return acc;
        },
        {},
      );

      // If we weren't given all of the path's required ids, we can't use it
      const diff = path.ids.reduce(
        (acc: string[], id: string) => (pathUrlIds[id] ? acc : acc.concat(id)),
        [],
      );
      if (diff.length > 0) {
        return;
      }

      specificity = path.ids.length;
      match = path.path.replace(
        /(<([^>]+)>)/g,
        (_m1, _m2, id) => `${pathUrlIds[id]}`,
      );
    });

    if (!match) {
      throw new RestResourceError('Could not find a path for request');
    }

    if (this.CUSTOM_PREFIX) {
      return `${this.CUSTOM_PREFIX}/${match}`;
    } else {
      return match;
    }
  }

  protected static createInstancesFromResponse<T extends Base = Base>(
    session: Session,
    data: Body,
  ): T[] {
    if (data[this.PLURAL_NAME] || Array.isArray(data[this.NAME])) {
      return (data[this.PLURAL_NAME] || data[this.NAME]).reduce(
        (acc: T[], entry: Body) =>
          acc.concat(this.createInstance<T>(session, entry)),
        [],
      );
    }

    if (data[this.NAME]) {
      return [this.createInstance<T>(session, data[this.NAME])];
    }

    return [];
  }

  protected static createInstance<T extends Base = Base>(
    session: Session,
    data: Body,
    prevInstance?: T,
  ): T {
    const instance: T = prevInstance
      ? prevInstance
      : new (this as any)({session});

    if (data) {
      instance.setData(data);
    }

    return instance;
  }

  #session: Session;

  get session(): Session {
    return this.#session;
  }

  constructor({session, fromData}: BaseConstructorArgs) {
    this.#session = session;

    if (fromData) {
      this.setData(fromData);
    }
  }

  public async save({update = false}: SaveArgs = {}): Promise<void> {
    const {PRIMARY_KEY, NAME} = this.resource();
    const method = this[PRIMARY_KEY] ? 'put' : 'post';

    const data = this.serialize(true);

    const response = await this.resource().request({
      http_method: method,
      operation: method,
      session: this.session,
      urlIds: {},
      body: {[this.resource().getJsonBodyName()]: data},
      entity: this,
    });

    const body: Body | undefined = (response.body as Body)[NAME];

    if (update && body) {
      this.setData(body);
    }
  }

  public async saveAndUpdate(): Promise<void> {
    await this.save({update: true});
  }

  public async delete(): Promise<void> {
    await this.resource().request({
      http_method: 'delete',
      operation: 'delete',
      session: this.session,
      urlIds: {},
      entity: this,
    });
  }

  public serialize(saving = false): Body {
    const {HAS_MANY, HAS_ONE, READ_ONLY_ATTRIBUTES} = this.resource();

    return Object.entries(this).reduce((acc: Body, [attribute, value]) => {
      if (
        ['#session'].includes(attribute) ||
        (saving && READ_ONLY_ATTRIBUTES.includes(attribute))
      ) {
        return acc;
      }

      if (attribute in HAS_MANY && value) {
        acc[attribute] = value.reduce((attrAcc: Body, entry: Base) => {
          return attrAcc.concat(this.serializeSubAttribute(entry, saving));
        }, []);
      } else if (attribute in HAS_ONE && value) {
        acc[attribute] = this.serializeSubAttribute(value, saving);
      } else {
        acc[attribute] = value;
      }

      return acc;
    }, {});
  }

  public toJSON(): Body {
    return this.serialize();
  }

  public request<T = unknown>(args: RequestArgs) {
    return this.resource().request<T>(args);
  }

  protected setData(data: Body): void {
    const {HAS_MANY, HAS_ONE} = this.resource();

    Object.entries(data).forEach(([attribute, val]) => {
      if (attribute in HAS_MANY) {
        const HasManyResource: typeof Base = HAS_MANY[attribute];
        this[attribute] = [];
        val.forEach((entry: Body) => {
          this[attribute].push(
            new HasManyResource({session: this.session, fromData: entry}),
          );
        });
      } else if (attribute in HAS_ONE) {
        const HasOneResource: typeof Base = HAS_ONE[attribute];
        this[attribute] = new HasOneResource({
          session: this.session,
          fromData: val,
        });
      } else {
        this[attribute] = val;
      }
    });
  }

  private resource(): typeof Base {
    return this.constructor as unknown as typeof Base;
  }

  private serializeSubAttribute(attribute: Base, saving: boolean): Body {
    return attribute.serialize
      ? attribute.serialize(saving)
      : this.resource()
          .createInstance(this.session, attribute)
          .serialize(saving);
  }
}
