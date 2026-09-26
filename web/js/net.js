// WebSocket client for the relay server (server/server.js).

export const PROTOCOL_VERSION = 1;

export class NetClient extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.id = null;
    this.room = null;
    this.name = null;
    this.retryDelay = 1000;
    this.closedByUser = false;
    this.reconnectTimer = null;
  }

  connect(room, name) {
    this.room = room;
    this.name = name;
    this.closedByUser = false;
    this.open();
  }

  open() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.retryDelay = 1000;
      ws.send(JSON.stringify({ t: 'join', v: PROTOCOL_VERSION, room: this.room, name: this.name }));
    });
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.t === 'welcome') this.id = msg.id;
      if (msg.t === 'error') this.closedByUser = true; // don't retry a rejected join
      this.dispatchEvent(new CustomEvent(msg.t, { detail: msg }));
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.id = null;
      this.dispatchEvent(new CustomEvent('disconnected'));
      if (!this.closedByUser) {
        this.reconnectTimer = setTimeout(() => this.open(), this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 15000);
      }
    });
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN && this.id !== null;
  }

  sendState(state) {
    if (this.connected) this.ws.send(JSON.stringify({ t: 'state', s: state }));
  }

  close() {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
