import EventEmitter from './events.js';
import { Chunk, MetaReadable, MetaWritable } from './streams.js';

const CALL_TIMEOUT = 7 * 1000;
const PING_INTERVAL = 60 * 1000;
const RECONNECT_TIMEOUT = 2 * 1000;

const connections = new Set();

window.addEventListener('online', () => {
  for (const connection of connections) {
    if (!connection.connected) connection.open();
  }
});

class MetacomError extends Error {
  constructor({ message, code }) {
    super(message);
    this.code = code;
  }
}

class MetacomInterface extends EventEmitter {
  constructor() {
    super();
  }
}

export class Metacom extends EventEmitter {
  constructor(url, options = {}) {
    super();
    this.url = url;
    this.socket = null;
    this.api = {};
    this.callId = 0;
    this.calls = new Map();
    this.streams = new Map();
    this.streamId = 0;
    this.eventId = 0;
    this.active = false;
    this.connected = false;
    this.opening = null;
    this.lastActivity = new Date().getTime();
    this.callTimeout = options.callTimeout || CALL_TIMEOUT;
    this.pingInterval = options.pingInterval || PING_INTERVAL;
    this.reconnectTimeout = options.reconnectTimeout || RECONNECT_TIMEOUT;
    this.open();
  }

  static create(url, options) {
    const { transport } = Metacom;
    const Transport = url.startsWith('ws') ? transport.ws : transport.http;
    return new Transport(url, options);
  }

  getStream(streamId) {
    const stream = this.streams.get(streamId);
    if (stream) return stream;
    throw new Error(`Stream ${streamId} is not initialized`);
  }

  createStream(name, size) {
    const streamId = ++this.streamId;
    const initData = { streamId, name, size };
    const transport = this;
    return new MetaWritable(transport, initData);
  }

  createBlobUploader(blob) {
    const name = blob.name || 'blob';
    const size = blob.size;
    const consumer = this.createStream(name, size);
    return {
      streamId: consumer.streamId,
      upload: async () => {
        const reader = blob.stream().getReader();
        let chunk;
        while (!(chunk = await reader.read()).done) {
          consumer.write(chunk.value);
        }
        consumer.end();
      },
    };
  }

  async message(data) {
    if (data === '{}') return;
    this.lastActivity = new Date().getTime();
    let packet;
    try {
      packet = JSON.parse(data);
    } catch {
      return;
    }
    const [callType, target] = Object.keys(packet);
    const callId = packet[callType];
    const args = packet[target];
    if (callId) {
      if (callType === 'callback') {
        const promised = this.calls.get(callId);
        if (!promised) return;
        const [resolve, reject] = promised;
        this.calls.delete(callId);
        if (packet.error) {
          reject(new MetacomError(packet.error));
          return;
        }
        resolve(args);
      } else if (callType === 'event') {
        const [interfaceName, eventName] = target.split('/');
        const metacomInterface = this.api[interfaceName];
        metacomInterface.emit(eventName, args);
      } else if (callType === 'stream') {
        const { stream: streamId, name, size, status } = packet;
        const stream = this.streams.get(streamId);
        if (name && typeof name === 'string' && Number.isSafeInteger(size)) {
          if (stream) {
            console.error(new Error(`Stream ${name} is already initialized`));
          } else {
            const streamData = { streamId, name, size };
            const stream = new MetaReadable(streamData);
            this.streams.set(streamId, stream);
          }
        } else if (!stream) {
          console.error(new Error(`Stream ${streamId} is not initialized`));
        } else if (status === 'end') {
          await stream.close();
          this.streams.delete(streamId);
        } else if (status === 'terminate') {
          await stream.terminate();
          this.streams.delete(streamId);
        } else {
          console.error(new Error('Stream packet structure error'));
        }
      }
    }
  }

  async binary(blob) {
    const buffer = await blob.arrayBuffer();
    const byteView = new Uint8Array(buffer);
    const { streamId, payload } = Chunk.decode(byteView);
    const stream = this.streams.get(streamId);
    if (stream) await stream.push(payload);
    else console.warn(`Stream ${streamId} is not initialized`);
  }

  async load(...interfaces) {
    const introspect = this.scaffold('system')('introspect');
    const introspection = await introspect(interfaces);
    const available = Object.keys(introspection);
    for (const interfaceName of interfaces) {
      if (!available.includes(interfaceName)) continue;
      const methods = new MetacomInterface();
      const iface = introspection[interfaceName];
      const request = this.scaffold(interfaceName);
      const methodNames = Object.keys(iface);
      for (const methodName of methodNames) {
        methods[methodName] = request(methodName);
      }
      methods.on('*', (eventName, data) => {
        const target = `${interfaceName}/${eventName}`;
        const packet = { event: ++this.eventId, [target]: data };
        this.send(JSON.stringify(packet));
      });
      this.api[interfaceName] = methods;
    }
  }

  scaffold(iname, ver) {
    return (methodName) =>
      async (args = {}) => {
        const callId = ++this.callId;
        const interfaceName = ver ? `${iname}.${ver}` : iname;
        const target = interfaceName + '/' + methodName;
        if (this.opening) await this.opening;
        if (!this.connected) await this.open();
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            if (this.calls.has(callId)) {
              this.calls.delete(callId);
              reject(new Error('Request timeout'));
            }
          }, this.callTimeout);
          this.calls.set(callId, [resolve, reject]);
          const packet = { call: callId, [target]: args };
          this.send(JSON.stringify(packet));
        });
      };
  }
}

class WebsocketTransport extends Metacom {
  async open() {
    if (this.opening) return this.opening;
    if (this.connected) return Promise.resolve();
    const socket = new WebSocket(this.url);
    this.active = true;
    this.socket = socket;
    connections.add(this);

    socket.addEventListener('message', ({ data }) => {
      if (typeof data === 'string') this.message(data);
      else this.binary(data);
    });

    socket.addEventListener('close', () => {
      this.opening = null;
      this.connected = false;
      this.emit('close');
      setTimeout(() => {
        if (this.active) this.open();
      }, this.reconnectTimeout);
    });

    socket.addEventListener('error', (err) => {
      this.emit('error', err);
      socket.close();
    });

    setInterval(() => {
      if (this.active) {
        const interval = new Date().getTime() - this.lastActivity;
        if (interval > this.pingInterval) this.send('{}');
      }
    }, this.pingInterval);

    this.opening = new Promise((resolve) => {
      socket.addEventListener('open', () => {
        this.opening = null;
        this.connected = true;
        this.emit('open');
        resolve();
      });
    });
    return this.opening;
  }

  close() {
    this.active = false;
    connections.delete(this);
    if (!this.socket) return;
    this.socket.close();
    this.socket = null;
  }

  send(data) {
    if (!this.connected) return;
    this.lastActivity = new Date().getTime();
    this.socket.send(data);
  }
}

class HttpTransport extends Metacom {
  async open() {
    this.active = true;
    this.connected = true;
    this.emit('open');
  }

  close() {
    this.active = false;
    this.connected = false;
  }

  send(data) {
    this.lastActivity = new Date().getTime();
    fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: data,
    }).then((res) =>
      res.text().then((packet) => {
        this.message(packet);
      }),
    );
  }
}

Metacom.transport = {
  ws: WebsocketTransport,
  http: HttpTransport,
};
