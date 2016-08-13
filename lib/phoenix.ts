namespace phoenix {

  const VSN = "1.0.0";
  const SOCKET_STATES = {connecting: 0, open: 1, closing: 2, closed: 3};
  const DEFAULT_TIMEOUT = 10000;
  const CHANNEL_STATES = {
    closed: "closed",
    errored: "errored",
    joined: "joined",
    joining: "joining",
    leaving: "leaving",
  };
  const CHANNEL_EVENTS = {
    close: "phx_close",
    error: "phx_error",
    join: "phx_join",
    reply: "phx_reply",
    leave: "phx_leave"
  };
  const TRANSPORTS = {
    longpoll: "longpoll",
    websocket: "websocket"
  };

  const XDomainRequest = (<any>window).XDomainRequest;
  const XMLHttpRequest = (<any>window).XMLHttpRequest;

  export class Push {

    channel: Channel;
    event: string;
    payload: any;
    receivedResp: any = null;
    timeout: number;
    timeoutTimer: number = null;
    recHooks: any[] = [];
    sent: boolean = false;
    ref: any;
    refEvent: any;

    // Initializes the Push
    //
    // channel - The Channel
    // event - The event, for example `"phx_join"`
    // payload - The payload, for example `{user_id: 123}`
    // timeout - The push timeout in milliseconds
    //
    constructor(channel: Channel, event, payload, timeout) {
      this.channel      = channel;
      this.event        = event;
      this.payload      = payload || {};
      this.timeout      = timeout;
    }

    resend(timeout) {
      this.timeout = timeout;
      this.cancelRefEvent();
      this.ref          = null;
      this.refEvent     = null;
      this.receivedResp = null;
      this.sent         = false;
      this.send();
    }

    send() { if (this.hasReceived("timeout")) { return; }
      this.startTimeout();
      this.sent = true;
      this.channel.socket.push({
        topic: this.channel.topic,
        event: this.event,
        payload: this.payload,
        ref: this.ref
      });
    }

    receive(status, callback) {
      if (this.hasReceived(status)) {
        callback(this.receivedResp.response);
      }

      this.recHooks.push({status, callback});
      return this;
    }


    // private

    matchReceive({status, response, ref}) {
      this.recHooks.filter( h => h.status === status )
                   .forEach( h => h.callback(response) );
    }

    cancelRefEvent() { if (!this.refEvent) { return; }
      this.channel.off(this.refEvent);
    }

    cancelTimeout() {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }

    startTimeout() { if (this.timeoutTimer) { return; }
      this.ref      = this.channel.socket.makeRef();
      this.refEvent = this.channel.replyEventName(this.ref);

      this.channel.on(this.refEvent, payload => {
        this.cancelRefEvent();
        this.cancelTimeout();
        this.receivedResp = payload;
        this.matchReceive(payload);
      });

      this.timeoutTimer = setTimeout(() => {
        this.trigger("timeout", {});
      }, this.timeout);
    }

    hasReceived(status) {
      return this.receivedResp && this.receivedResp.status === status;
    }

    trigger(status, response) {
      this.channel.trigger(this.refEvent, {status, response});
    }
  }

  export class Channel {
    state: string = CHANNEL_STATES.closed;
    topic: string;
    params: Object;
    socket: Socket;
    bindings: { event: string, callback: (payload?, ref?) => void } [] = [];
    timeout: number;
    joinedOnce: boolean = false;
    joinPush: Push;
    pushBuffer: any[] = [];
    rejoinTimer: Timer;

    constructor(topic, params, socket) {
      this.topic       = topic;
      this.params      = params || {};
      this.socket      = socket;
      this.timeout     = this.socket.timeout;
      this.joinPush    = new Push(this, CHANNEL_EVENTS.join, this.params, this.timeout);
      this.rejoinTimer  = new Timer(
        () => this.rejoinUntilConnected(),
        this.socket.reconnectAfterMs
      );
      this.joinPush.receive("ok", () => {
        this.state = CHANNEL_STATES.joined;
        this.rejoinTimer.reset();
        this.pushBuffer.forEach( pushEvent => pushEvent.send() );
        this.pushBuffer = [];
      });
      this.onClose( () => {
        this.rejoinTimer.reset();
        this.socket.log("channel", `close ${this.topic} ${this.joinRef()}`);
        this.state = CHANNEL_STATES.closed;
        this.socket.remove(this);
      });
      this.onError( reason => {
        if (this.isLeaving() || this.isClosed()) {
          return;
        }
        this.socket.log("channel", `error ${this.topic}`, reason);
        this.state = CHANNEL_STATES.errored;
        this.rejoinTimer.scheduleTimeout();
      });
      this.joinPush.receive("timeout", () => {
        if (!this.isJoining()) {
          return;
        }
        this.socket.log("channel", `timeout ${this.topic}`, this.joinPush.timeout);
        this.state = CHANNEL_STATES.errored;
        this.rejoinTimer.scheduleTimeout();
      });
      this.on(CHANNEL_EVENTS.reply, (payload, ref) => {
        this.trigger(this.replyEventName(ref), payload);
      });
    }

    rejoinUntilConnected() {
      this.rejoinTimer.scheduleTimeout();
      if (this.socket.isConnected()) {
        this.rejoin();
      }
    }

    join(timeout = this.timeout) {
      if (this.joinedOnce) {
        throw(`tried to join multiple times. 'join' can only be called a single time per channel instance`);
      } else {
        this.joinedOnce = true;
        this.rejoin(timeout);
        return this.joinPush;
      }
    }

    onClose(callback) {
      this.on(CHANNEL_EVENTS.close, callback);
    }

    onError(callback) {
      this.on(CHANNEL_EVENTS.error, reason => callback(reason) );
    }

    on(event, callback) {
      this.bindings.push({event, callback});
    }

    off(event) {
      this.bindings = this.bindings.filter( bind => bind.event !== event );
    }

    canPush() {
      return this.socket.isConnected() && this.isJoined();
    }

    push(event, payload, timeout = this.timeout) {
      if (!this.joinedOnce) {
        throw(`tried to push '${event}' to '${this.topic}' before joining. Use channel.join() before pushing events`);
      }
      let pushEvent = new Push(this, event, payload, timeout);
      if (this.canPush()) {
        pushEvent.send();
      } else {
        pushEvent.startTimeout();
        this.pushBuffer.push(pushEvent);
      }

      return pushEvent;
    }

    // Leaves the channel
    //
    // Unsubscribes from server events, and
    // instructs channel to terminate on server
    //
    // Triggers onClose() hooks
    //
    // To receive leave acknowledgements, use the a `receive`
    // hook to bind to the server ack, ie:
    //
    //     channel.leave().receive("ok", () => alert("left!") )
    //
    leave(timeout = this.timeout) {
      this.state = CHANNEL_STATES.leaving;
      let onClose = () => {
        this.socket.log("channel", `leave ${this.topic}`);
        this.trigger(CHANNEL_EVENTS.close, "leave", this.joinRef());
      };
      let leavePush = new Push(this, CHANNEL_EVENTS.leave, {}, timeout);
      leavePush.receive("ok", () => onClose() )
               .receive("timeout", () => onClose() );
      leavePush.send();
      if (!this.canPush()) {
        leavePush.trigger("ok", {});
      }

      return leavePush;
    }

    // Overridable message hook
    //
    // Receives all events for specialized message handling
    // before dispatching to the channel callbacks.
    //
    // Must return the payload, modified or unmodified
    onMessage(event, payload, ref) {
      return payload;
    }

    // private

    isMember(topic) {
      return this.topic === topic;
    }

    joinRef() {
      return this.joinPush.ref;
    }

    sendJoin(timeout) {
      this.state = CHANNEL_STATES.joining;
      this.joinPush.resend(timeout);
    }

    rejoin(timeout = this.timeout) {
      if (this.isLeaving()) {
        return;
      }
      this.sendJoin(timeout);
    }

    trigger(event, payload?, ref = null) {
      let {close, error, leave, join} = CHANNEL_EVENTS;
      if (ref && [close, error, leave, join].indexOf(event) >= 0 && ref !== this.joinRef()) {
        return;
      }
      let handledPayload = this.onMessage(event, payload, ref);
      if (payload && !handledPayload) {
        throw("channel onMessage callbacks must return the payload, modified or unmodified");
      }

      this.bindings.filter( bind => bind.event === event)
                   .map( bind => bind.callback(handledPayload, ref));
    }

    replyEventName(ref) {
      return `chan_reply_${ref}`;
    }

    isClosed() { return this.state === CHANNEL_STATES.closed; }
    isErrored() { return this.state === CHANNEL_STATES.errored; }
    isJoined() { return this.state === CHANNEL_STATES.joined; }
    isJoining() { return this.state === CHANNEL_STATES.joining; }
    isLeaving() { return this.state === CHANNEL_STATES.leaving; }
  }

  export interface SocketOptions {
    timeout?: number;
    transport?: any;
    heartbeatIntervalMs?: number;
    reconnectAfterMs?: number;
    logger?: any;
    longpollerTimeout?: number;
    params?: any;
  }

  export class Socket {

    stateChangeCallbacks = {open: [], close: [], error: [], message: []};
    channels: Channel[] = [];
    sendBuffer: any[] = [];
    ref: number = 0;
    timeout: number;
    transport: any;
    heartbeatTimer: number;
    heartbeatIntervalMs: number;
    reconnectAfterMs: number | ((tries: any) => number);
    logger: any;
    longpollerTimeout: number;
    params: any;
    endPoint: string;
    reconnectTimer: Timer;
    conn: any; // new transport();

    // Initializes the Socket
    //
    // endPoint - The string WebSocket endpoint, ie, "ws://example.com/ws",
    //                                               "wss://example.com"
    //                                               "/ws" (inherited host & protocol)
    // opts - Optional configuration
    //   transport - The Websocket Transport, for example WebSocket or Phoenix.LongPoll.
    //               Defaults to WebSocket with automatic LongPoll fallback.
    //   timeout - The default timeout in milliseconds to trigger push timeouts.
    //             Defaults `DEFAULT_TIMEOUT`
    //   heartbeatIntervalMs - The millisec interval to send a heartbeat message
    //   reconnectAfterMs - The optional function that returns the millsec
    //                      reconnect interval. Defaults to stepped backoff of:
    //
    //     function(tries){
    //       return [1000, 5000, 10000][tries - 1] || 10000
    //     }
    //
    //   logger - The optional function for specialized logging, ie:
    //     `logger: (kind, msg, data) => { console.log(`${kind}: ${msg}`, data) }
    //
    //   longpollerTimeout - The maximum timeout of a long poll AJAX request.
    //                        Defaults to 20s (double the server long poll timer).
    //
    //   params - The optional params to pass when connecting
    //
    // For IE8 support use an ES5-shim (https://github.com/es-shims/es5-shim)
    //
    constructor(endPoint, opts: SocketOptions) {
      this.timeout              = opts.timeout || DEFAULT_TIMEOUT;
      this.transport            = opts.transport || WebSocket || LongPoll;
      this.heartbeatIntervalMs  = opts.heartbeatIntervalMs || 30000;
      this.reconnectAfterMs     = opts.reconnectAfterMs || function(tries) {
        return [1000, 2000, 5000, 10000][tries - 1] || 10000;
      };
      this.logger               = opts.logger || function(){}; // noop
      this.longpollerTimeout    = opts.longpollerTimeout || 20000;
      this.params               = opts.params || {};
      this.endPoint             = `${endPoint}/${TRANSPORTS.websocket}`;
      this.reconnectTimer       = new Timer(() => {
        this.disconnect(() => this.connect());
      }, this.reconnectAfterMs);
    }

    protocol() { return location.protocol.match(/^https/) ? "wss" : "ws"; }

    endPointURL() {
      let uri = Ajax.appendParams(
        Ajax.appendParams(this.endPoint, this.params), {vsn: VSN});
      if (uri.charAt(0) !== "/") { return uri; }
      if (uri.charAt(1) === "/") { return `${this.protocol()}:${uri}`; }

      return `${this.protocol()}://${location.host}${uri}`;
    }

    disconnect(callback?, code?, reason?) {
      if (this.conn) {
        this.conn.onclose = function(){}; // noop
        if (code) {
          this.conn.close(code, reason || "");
        } else {
          this.conn.close();
        }
        this.conn = null;
      }
      callback && callback();
    }

    // params - The params to send when connecting, for example `{user_id: userToken}`
    connect(params?) {
      if (params) {
        console && console.log("passing params to connect is deprecated. Instead pass :params to the Socket constructor");
        this.params = params;
      }
      if (this.conn) { return; }

      this.conn = new this.transport(this.endPointURL());
      this.conn.timeout   = this.longpollerTimeout;
      this.conn.onopen    = () => this.onConnOpen();
      this.conn.onerror   = error => this.onConnError(error);
      this.conn.onmessage = event => this.onConnMessage(event);
      this.conn.onclose   = event => this.onConnClose(event);
    }

    // Logs the message. Override `this.logger` for specialized logging. noops by default
    log(kind, msg, data?) { this.logger(kind, msg, data); }

    // Registers callbacks for connection state change events
    //
    // Examples
    //
    //    socket.onError(function(error){ alert("An error occurred") })
    //
    onOpen     (callback) { this.stateChangeCallbacks.open.push(callback); }
    onClose    (callback) { this.stateChangeCallbacks.close.push(callback); }
    onError    (callback) { this.stateChangeCallbacks.error.push(callback); }
    onMessage  (callback) { this.stateChangeCallbacks.message.push(callback); }

    onConnOpen() {
      this.log("transport", `connected to ${this.endPointURL()}`);
      this.flushSendBuffer();
      this.reconnectTimer.reset();
      if (!this.conn.skipHeartbeat) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatIntervalMs);
      }
      this.stateChangeCallbacks.open.forEach( callback => callback() );
    }

    onConnClose(event) {
      this.log("transport", "close", event);
      this.triggerChanError();
      clearInterval(this.heartbeatTimer);
      this.reconnectTimer.scheduleTimeout();
      this.stateChangeCallbacks.close.forEach( callback => callback(event) );
    }

    onConnError(error) {
      this.log("transport", error);
      this.triggerChanError();
      this.stateChangeCallbacks.error.forEach( callback => callback(error) );
    }

    triggerChanError() {
      this.channels.forEach( channel => channel.trigger(CHANNEL_EVENTS.error) );
    }

    connectionState() {
      switch (this.conn && this.conn.readyState) {
        case SOCKET_STATES.connecting: return "connecting";
        case SOCKET_STATES.open:       return "open";
        case SOCKET_STATES.closing:    return "closing";
        default:                       return "closed";
      }
    }

    isConnected() { return this.connectionState() === "open"; }

    remove(channel) {
      this.channels = this.channels.filter(c => c.joinRef() !== channel.joinRef());
    }

    channel(topic, chanParams = {}) {
      let chan = new Channel(topic, chanParams, this);
      this.channels.push(chan);
      return chan;
    }

    push(data) {
      let {topic, event, payload, ref} = data;
      let callback = () => this.conn.send(JSON.stringify(data));
      this.log("push", `${topic} ${event} (${ref})`, payload);
      if (this.isConnected()) {
        callback();
      }
      else {
        this.sendBuffer.push(callback);
      }
    }

    // Return the next message ref, accounting for overflows
    makeRef() {
      let newRef = this.ref + 1;
      if (newRef === this.ref) { this.ref = 0; } else { this.ref = newRef; }

      return this.ref.toString();
    }

    sendHeartbeat() {
      if (!this.isConnected()) { return; }
      this.push({topic: "phoenix", event: "heartbeat", payload: {}, ref: this.makeRef()});
    }

    flushSendBuffer() {
      if (this.isConnected() && this.sendBuffer.length > 0) {
        this.sendBuffer.forEach( callback => callback() );
        this.sendBuffer = [];
      }
    }

    onConnMessage(rawMessage) {
      let msg = JSON.parse(rawMessage.data);
      let {topic, event, payload, ref} = msg;
      this.log("receive", `${payload.status || ""} ${topic} ${event} ${ref && "(" + ref + ")" || ""}`, payload);
      this.channels.filter( channel => channel.isMember(topic) )
                   .forEach( channel => channel.trigger(event, payload, ref) );
      this.stateChangeCallbacks.message.forEach( callback => callback(msg) );
    }
  }


  export class LongPoll {
    endPoint: string = null;
    pollEndpoint: string;
    token: string = null;
    skipHeartbeat: boolean = true;
    onopen: () => void = function() {}; // noop
    onerror: (reason?) => void = function() {}; // noop
    onmessage: (message: { data?: any }) => void = function() {}; // noop
    onclose: () => void = function() {}; // noop
    readyState: number = SOCKET_STATES.connecting;
    timeout: number;

    constructor(endPoint) {
      this.pollEndpoint    = this.normalizeEndpoint(endPoint);
      this.poll();
    }

    normalizeEndpoint(endPoint) {
      return(endPoint
        .replace("ws://", "http://")
        .replace("wss://", "https://")
        .replace(new RegExp("(.*)\/" + TRANSPORTS.websocket), "$1/" + TRANSPORTS.longpoll));
    }

    endpointURL() {
      return Ajax.appendParams(this.pollEndpoint, {token: this.token});
    }

    closeAndRetry() {
      this.close();
      this.readyState = SOCKET_STATES.connecting;
    }

    ontimeout() {
      this.onerror("timeout");
      this.closeAndRetry();
    }

    poll() {
      if (!(this.readyState === SOCKET_STATES.open || this.readyState === SOCKET_STATES.connecting)) { return; }

      Ajax.request("GET", this.endpointURL(), "application/json", null, this.timeout, this.ontimeout.bind(this), (resp: { status: number, messages?: any[], token?: string}) => {
        let status: number = 0;
        let messages: any[] = [];
        if (resp) {
          status = resp.status;
          messages = resp.messages;
          this.token = resp.token;
        }

        switch (status) {
          case 200:
            messages.forEach( msg => this.onmessage({data: JSON.stringify(msg)}) );
            this.poll();
            break;
          case 204:
            this.poll();
            break;
          case 410:
            this.readyState = SOCKET_STATES.open;
            this.onopen();
            this.poll();
            break;
          case 0:
          case 500:
            this.onerror();
            this.closeAndRetry();
            break;
          default: throw(`unhandled poll status ${status}`);
        }
      });
    }

    send(body) {
      Ajax.request("POST", this.endpointURL(), "application/json", body, this.timeout, this.onerror.bind(this, "timeout"), (resp) => {
        if (!resp || resp.status !== 200) {
          this.onerror(status);
          this.closeAndRetry();
        }
      });
    }

    close(code?, reason?) {
      this.readyState = SOCKET_STATES.closed;
      this.onclose();
    }
  }


  class Ajax {

    static states = { complete: 4 };

    static request(method, endPoint, accept, body, timeout, ontimeout, callback) {
      if (XDomainRequest) {
        let req = new XDomainRequest(); // IE8, IE9
        this.xdomainRequest(req, method, endPoint, body, timeout, ontimeout, callback);
      } else {
        let req = XMLHttpRequest ?
                    new XMLHttpRequest() : // IE7+, Firefox, Chrome, Opera, Safari
                    new ActiveXObject("Microsoft.XMLHTTP"); // IE6, IE5
        this.xhrRequest(req, method, endPoint, accept, body, timeout, ontimeout, callback);
      }
    }

    static xdomainRequest(req, method, endPoint, body, timeout, ontimeout, callback) {
      req.timeout = timeout;
      req.open(method, endPoint);
      req.onload = () => {
        let response = this.parseJSON(req.responseText);
        callback && callback(response);
      };
      if (ontimeout) { req.ontimeout = ontimeout; }

      // Work around bug in IE9 that requires an attached onprogress handler
      req.onprogress = () => {};

      req.send(body);
    }

    static xhrRequest(req, method, endPoint, accept, body, timeout, ontimeout, callback) {
      req.timeout = timeout;
      req.open(method, endPoint, true);
      req.setRequestHeader("Content-Type", accept);
      req.onerror = () => { callback && callback(null); };
      req.onreadystatechange = () => {
        if (req.readyState === this.states.complete && callback) {
          let response = this.parseJSON(req.responseText);
          callback(response);
        }
      };
      if (ontimeout) { req.ontimeout = ontimeout; }

      req.send(body);
    }

    static parseJSON(resp) {
      return (resp && resp !== "") ?
               JSON.parse(resp) :
               null;
    }

    static serialize(obj, parentKey?) {
      let queryStr = [];
      for (let key in obj) { if (!obj.hasOwnProperty(key)) { continue; }
        let paramKey = parentKey ? `${parentKey}[${key}]` : key;
        let paramVal = obj[key];
        if (typeof paramVal === "object") {
          queryStr.push(this.serialize(paramVal, paramKey));
        } else {
          queryStr.push(encodeURIComponent(paramKey) + "=" + encodeURIComponent(paramVal));
        }
      }
      return queryStr.join("&");
    }

    static appendParams(url, params) {
      if (Object.keys(params).length === 0) { return url; }

      let prefix = url.match(/\?/) ? "&" : "?";
      return `${url}${prefix}${this.serialize(params)}`;
    }
  }


  export class Presence {

    static syncState(currentState, newState, onJoin, onLeave) {
      let state = this.clone(currentState);
      let joins = {};
      let leaves = {};

      this.map(state, (key, presence) => {
        if (!newState[key]) {
          leaves[key] = presence;
        }
      });

      this.map(newState, (key, newPresence) => {
        let currentPresence = state[key];
        if (currentPresence) {
          let newRefs = newPresence.metas.map(m => m.phx_ref);
          let curRefs = currentPresence.metas.map(m => m.phx_ref);
          let joinedMetas = newPresence.metas.filter(m => curRefs.indexOf(m.phx_ref) < 0);
          let leftMetas = currentPresence.metas.filter(m => newRefs.indexOf(m.phx_ref) < 0);
          if (joinedMetas.length > 0) {
            joins[key] = newPresence;
            joins[key].metas = joinedMetas;
          }
          if (leftMetas.length > 0) {
            leaves[key] = this.clone(currentPresence);
            leaves[key].metas = leftMetas;
          }
        } else {
          joins[key] = newPresence;
        }
      });
      return this.syncDiff(state, {joins: joins, leaves: leaves}, onJoin, onLeave);
    }

    static syncDiff(currentState, {joins, leaves}, onJoin, onLeave) {
      let state = this.clone(currentState);
      if (!onJoin) { onJoin = function(){}; }
      if (!onLeave) { onLeave = function(){}; }

      this.map(joins, (key, newPresence) => {
        let currentPresence = state[key];
        state[key] = newPresence;
        if (currentPresence) {
          state[key].metas.unshift(...currentPresence.metas);
        }
        onJoin(key, currentPresence, newPresence);
      });
      this.map(leaves, (key, leftPresence) => {
        let currentPresence = state[key];
        if (!currentPresence) { return; }
        let refsToRemove = leftPresence.metas.map(m => m.phx_ref);
        currentPresence.metas = currentPresence.metas.filter(p => {
          return refsToRemove.indexOf(p.phx_ref) < 0;
        });
        onLeave(key, currentPresence, leftPresence);
        if (currentPresence.metas.length === 0) {
          delete state[key];
        }
      });
      return state;
    }

    static list(presences, chooser) {
      if (!chooser) { chooser = function(key, pres){ return pres; }; }

      return this.map(presences, (key, presence) => {
        return chooser(key, presence);
      });
    }

    // private

    static map(obj, func) {
      return Object.getOwnPropertyNames(obj).map(key => func(key, obj[key]));
    }

    static clone(obj) { return JSON.parse(JSON.stringify(obj)); }
  };


  // Creates a timer that accepts a `timerCalc` function to perform
  // calculated timeout retries, such as exponential backoff.
  //
  // ## Examples
  //
  //    let reconnectTimer = new Timer(() => this.connect(), function(tries){
  //      return [1000, 5000, 10000][tries - 1] || 10000
  //    })
  //    reconnectTimer.scheduleTimeout() // fires after 1000
  //    reconnectTimer.scheduleTimeout() // fires after 5000
  //    reconnectTimer.reset()
  //    reconnectTimer.scheduleTimeout() // fires after 1000
  //
  export class Timer {
    callback: any;
    timerCalc: any;
    timer: any = null;
    tries: number = 0;

    constructor(callback, timerCalc) {
      this.callback  = callback;
      this.timerCalc = timerCalc;
    }

    reset() {
      this.tries = 0;
      clearTimeout(this.timer);
    }

    // Cancels any previous scheduleTimeout and schedules callback
    scheduleTimeout() {
      clearTimeout(this.timer);

      this.timer = setTimeout(() => {
        this.tries = this.tries + 1;
        this.callback();
      }, this.timerCalc(this.tries + 1));
    }
  }
}

export = phoenix;
