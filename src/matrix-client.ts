export interface Credentials {
  userId: string;
}

export interface MatrixRoom {
  getAliases(): string[];
}

export interface UploadOptions {
  name: string;
  type?: string;
  rawResponse?: boolean;
  onlyContentUri?: boolean;
}

export interface UploadResponse {
  content_uri: string;
}

export interface SendImageInfo {
  mimetype: string;
  h?: number;
  w?: number;
  size?: number;
}

export interface SendMessageParams {
  body: string;
  msgtype: string;
}

export interface CreateRoomResponse {
  room_id: string;
}

export interface MatrixClient {
  startClient(): void;
  on(name: string, any): void;
  credentials: Credentials;
  getRoomIdForAlias(alias: string): Promise<{room_id: string}>;
  joinRoom(id: string): Promise<void>;
  deleteAlias(alias: string): Promise<void>;
  getRoom(roomId: string): MatrixRoom;
  mxcUrlToHttp(mxcUrl: string): string;
  uploadContent(data: Buffer, UploadOptions): Promise<UploadResponse>;
  sendImageMessage(roomId: string, url: string, info: SendImageInfo, text: string) : Promise<void>;
  sendMessage(roomId: string, SendMessageParams): Promise<void>;
  getAccountData(eventType: string): any;
  setAccountData(eventType: string, contents: any): Promise<void>;
  invite(roomId: string, userId: string): Promise<void>;
  setRoomTag(roomId: string, tagName: string, metadata): Promise<void>;
  setPowerLevel(roomId: string, userId: string, powrLevel: number): Promise<void>;
  setRoomName(roomId: string, name: string): Promise<void>;
  sendStateEvent(roomId: string, eventType: string, content: any, stateKey: string): Promise<void>;
  createRoom(options: any): Promise<CreateRoomResponse>;
  setDeviceDetails(device_id: string, body: any): Promise<void>;
  getDeviceId(): string;
  getDevices(): Promise<any>;
  leave(roomId: string): Promise<void>;
}
