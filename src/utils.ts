import { MatrixClient, UploadResponse } from './matrix-client';

export const autoTagger = (senderId, self) => (text='') => {
  let out;
  if (senderId === undefined) {
    // tag the message to know it was sent by the bridge
    out = self.tagMatrixMessage(text);
  } else {
    out = text;
  }
  return out;
};

export const createUploader = (client : MatrixClient, name: string, type?: string) => {
  return {
    upload: (buffer : Buffer, opts={})=>{
      return client.uploadContent(buffer, {
        name, type,
        rawResponse: false,
        ...opts
      }).then((res)=>{
        return {
          content_uri: res.content_uri || res,
          size: buffer.length
        };
      });
    }
  }
}
