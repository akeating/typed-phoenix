"use strict";
var phoenix;
(function (phoenix) {
    var VSN = "1.0.0";
    var SOCKET_STATES = { connecting: 0, open: 1, closing: 2, closed: 3 };
    var DEFAULT_TIMEOUT = 10000;
    var CHANNEL_STATES = {
        closed: "closed",
        errored: "errored",
        joined: "joined",
        joining: "joining",
        leaving: "leaving"
    };
    var CHANNEL_EVENTS = {
        close: "phx_close",
        error: "phx_error",
        join: "phx_join",
        reply: "phx_reply",
        leave: "phx_leave"
    };
    var TRANSPORTS = {
        longpoll: "longpoll",
        websocket: "websocket"
    };
    var XDomainRequest = window.XDomainRequest;
    var XMLHttpRequest = window.XMLHttpRequest;
    var Push = (function () {
        // Initializes the Push
        //
        // channel - The Channel
        // event - The event, for example `"phx_join"`
        // payload - The payload, for example `{user_id: 123}`
        // timeout - The push timeout in milliseconds
        //
        function Push(channel, event, payload, timeout) {
            this.receivedResp = null;
            this.timeoutTimer = null;
            this.recHooks = [];
            this.sent = false;
            this.channel = channel;
            this.event = event;
            this.payload = payload || {};
            this.timeout = timeout;
        }
        Push.prototype.resend = function (timeout) {
            this.timeout = timeout;
            this.cancelRefEvent();
            this.ref = null;
            this.refEvent = null;
            this.receivedResp = null;
            this.sent = false;
            this.send();
        };
        Push.prototype.send = function () {
            if (this.hasReceived("timeout")) {
                return;
            }
            this.startTimeout();
            this.sent = true;
            this.channel.socket.push({
                topic: this.channel.topic,
                event: this.event,
                payload: this.payload,
                ref: this.ref
            });
        };
        Push.prototype.receive = function (status, callback) {
            if (this.hasReceived(status)) {
                callback(this.receivedResp.response);
            }
            this.recHooks.push({ status: status, callback: callback });
            return this;
        };
        // private
        Push.prototype.matchReceive = function (_a) {
            var status = _a.status, response = _a.response, ref = _a.ref;
            this.recHooks.filter(function (h) { return h.status === status; })
                .forEach(function (h) { return h.callback(response); });
        };
        Push.prototype.cancelRefEvent = function () {
            if (!this.refEvent) {
                return;
            }
            this.channel.off(this.refEvent);
        };
        Push.prototype.cancelTimeout = function () {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        };
        Push.prototype.startTimeout = function () {
            var _this = this;
            if (this.timeoutTimer) {
                return;
            }
            this.ref = this.channel.socket.makeRef();
            this.refEvent = this.channel.replyEventName(this.ref);
            this.channel.on(this.refEvent, function (payload) {
                _this.cancelRefEvent();
                _this.cancelTimeout();
                _this.receivedResp = payload;
                _this.matchReceive(payload);
            });
            this.timeoutTimer = setTimeout(function () {
                _this.trigger("timeout", {});
            }, this.timeout);
        };
        Push.prototype.hasReceived = function (status) {
            return this.receivedResp && this.receivedResp.status === status;
        };
        Push.prototype.trigger = function (status, response) {
            this.channel.trigger(this.refEvent, { status: status, response: response });
        };
        return Push;
    }());
    phoenix.Push = Push;
    ;
    var Channel = (function () {
        function Channel(topic, params, socket) {
            var _this = this;
            this.state = CHANNEL_STATES.closed;
            this.bindings = [];
            this.joinedOnce = false;
            this.pushBuffer = [];
            this.topic = topic;
            this.params = params || {};
            this.socket = socket;
            this.timeout = this.socket.timeout;
            this.joinPush = new Push(this, CHANNEL_EVENTS.join, this.params, this.timeout);
            this.rejoinTimer = new Timer(function () { return _this.rejoinUntilConnected(); }, this.socket.reconnectAfterMs);
            this.joinPush.receive("ok", function () {
                _this.state = CHANNEL_STATES.joined;
                _this.rejoinTimer.reset();
                _this.pushBuffer.forEach(function (pushEvent) { return pushEvent.send(); });
                _this.pushBuffer = [];
            });
            this.onClose(function () {
                _this.rejoinTimer.reset();
                _this.socket.log("channel", "close " + _this.topic + " " + _this.joinRef());
                _this.state = CHANNEL_STATES.closed;
                _this.socket.remove(_this);
            });
            this.onError(function (reason) {
                if (_this.isLeaving() || _this.isClosed()) {
                    return;
                }
                _this.socket.log("channel", "error " + _this.topic, reason);
                _this.state = CHANNEL_STATES.errored;
                _this.rejoinTimer.scheduleTimeout();
            });
            this.joinPush.receive("timeout", function () {
                if (!_this.isJoining()) {
                    return;
                }
                _this.socket.log("channel", "timeout " + _this.topic, _this.joinPush.timeout);
                _this.state = CHANNEL_STATES.errored;
                _this.rejoinTimer.scheduleTimeout();
            });
            this.on(CHANNEL_EVENTS.reply, function (payload, ref) {
                _this.trigger(_this.replyEventName(ref), payload);
            });
        }
        Channel.prototype.rejoinUntilConnected = function () {
            this.rejoinTimer.scheduleTimeout();
            if (this.socket.isConnected()) {
                this.rejoin();
            }
        };
        Channel.prototype.join = function (timeout) {
            if (timeout === void 0) { timeout = this.timeout; }
            if (this.joinedOnce) {
                throw ("tried to join multiple times. 'join' can only be called a single time per channel instance");
            }
            else {
                this.joinedOnce = true;
                this.rejoin(timeout);
                return this.joinPush;
            }
        };
        Channel.prototype.onClose = function (callback) {
            this.on(CHANNEL_EVENTS.close, callback);
        };
        Channel.prototype.onError = function (callback) {
            this.on(CHANNEL_EVENTS.error, function (reason) { return callback(reason); });
        };
        Channel.prototype.on = function (event, callback) {
            this.bindings.push({ event: event, callback: callback });
        };
        Channel.prototype.off = function (event) {
            this.bindings = this.bindings.filter(function (bind) { return bind.event !== event; });
        };
        Channel.prototype.canPush = function () {
            return this.socket.isConnected() && this.isJoined();
        };
        Channel.prototype.push = function (event, payload, timeout) {
            if (timeout === void 0) { timeout = this.timeout; }
            if (!this.joinedOnce) {
                throw ("tried to push '" + event + "' to '" + this.topic + "' before joining. Use channel.join() before pushing events");
            }
            var pushEvent = new Push(this, event, payload, timeout);
            if (this.canPush()) {
                pushEvent.send();
            }
            else {
                pushEvent.startTimeout();
                this.pushBuffer.push(pushEvent);
            }
            return pushEvent;
        };
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
        Channel.prototype.leave = function (timeout) {
            var _this = this;
            if (timeout === void 0) { timeout = this.timeout; }
            this.state = CHANNEL_STATES.leaving;
            var onClose = function () {
                _this.socket.log("channel", "leave " + _this.topic);
                _this.trigger(CHANNEL_EVENTS.close, "leave", _this.joinRef());
            };
            var leavePush = new Push(this, CHANNEL_EVENTS.leave, {}, timeout);
            leavePush.receive("ok", function () { return onClose(); })
                .receive("timeout", function () { return onClose(); });
            leavePush.send();
            if (!this.canPush()) {
                leavePush.trigger("ok", {});
            }
            return leavePush;
        };
        // Overridable message hook
        //
        // Receives all events for specialized message handling
        // before dispatching to the channel callbacks.
        //
        // Must return the payload, modified or unmodified
        Channel.prototype.onMessage = function (event, payload, ref) {
            return payload;
        };
        // private
        Channel.prototype.isMember = function (topic) {
            return this.topic === topic;
        };
        Channel.prototype.joinRef = function () {
            return this.joinPush.ref;
        };
        Channel.prototype.sendJoin = function (timeout) {
            this.state = CHANNEL_STATES.joining;
            this.joinPush.resend(timeout);
        };
        Channel.prototype.rejoin = function (timeout) {
            if (timeout === void 0) { timeout = this.timeout; }
            if (this.isLeaving()) {
                return;
            }
            this.sendJoin(timeout);
        };
        Channel.prototype.trigger = function (event, payload, ref) {
            if (ref === void 0) { ref = null; }
            var close = CHANNEL_EVENTS.close, error = CHANNEL_EVENTS.error, leave = CHANNEL_EVENTS.leave, join = CHANNEL_EVENTS.join;
            if (ref && [close, error, leave, join].indexOf(event) >= 0 && ref !== this.joinRef()) {
                return;
            }
            var handledPayload = this.onMessage(event, payload, ref);
            if (payload && !handledPayload) {
                throw ("channel onMessage callbacks must return the payload, modified or unmodified");
            }
            this.bindings.filter(function (bind) { return bind.event === event; })
                .map(function (bind) { return bind.callback(handledPayload, ref); });
        };
        Channel.prototype.replyEventName = function (ref) {
            return "chan_reply_" + ref;
        };
        Channel.prototype.isClosed = function () { return this.state === CHANNEL_STATES.closed; };
        Channel.prototype.isErrored = function () { return this.state === CHANNEL_STATES.errored; };
        Channel.prototype.isJoined = function () { return this.state === CHANNEL_STATES.joined; };
        Channel.prototype.isJoining = function () { return this.state === CHANNEL_STATES.joining; };
        Channel.prototype.isLeaving = function () { return this.state === CHANNEL_STATES.leaving; };
        return Channel;
    }());
    phoenix.Channel = Channel;
    var Socket = (function () {
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
        function Socket(endPoint, opts) {
            var _this = this;
            this.stateChangeCallbacks = { open: [], close: [], error: [], message: [] };
            this.channels = [];
            this.sendBuffer = [];
            this.ref = 0;
            this.timeout = opts.timeout || DEFAULT_TIMEOUT;
            this.transport = opts.transport || WebSocket || LongPoll;
            this.heartbeatIntervalMs = opts.heartbeatIntervalMs || 30000;
            this.reconnectAfterMs = opts.reconnectAfterMs || function (tries) {
                return [1000, 2000, 5000, 10000][tries - 1] || 10000;
            };
            this.logger = opts.logger || function () { }; // noop
            this.longpollerTimeout = opts.longpollerTimeout || 20000;
            this.params = opts.params || {};
            this.endPoint = endPoint + "/" + TRANSPORTS.websocket;
            this.reconnectTimer = new Timer(function () {
                _this.disconnect(function () { return _this.connect(); });
            }, this.reconnectAfterMs);
        }
        Socket.prototype.protocol = function () { return location.protocol.match(/^https/) ? "wss" : "ws"; };
        Socket.prototype.endPointURL = function () {
            var uri = Ajax.appendParams(Ajax.appendParams(this.endPoint, this.params), { vsn: VSN });
            if (uri.charAt(0) !== "/") {
                return uri;
            }
            if (uri.charAt(1) === "/") {
                return this.protocol() + ":" + uri;
            }
            return this.protocol() + "://" + location.host + uri;
        };
        Socket.prototype.disconnect = function (callback, code, reason) {
            if (this.conn) {
                this.conn.onclose = function () { }; // noop
                if (code) {
                    this.conn.close(code, reason || "");
                }
                else {
                    this.conn.close();
                }
                this.conn = null;
            }
            callback && callback();
        };
        // params - The params to send when connecting, for example `{user_id: userToken}`
        Socket.prototype.connect = function (params) {
            var _this = this;
            if (params) {
                console && console.log("passing params to connect is deprecated. Instead pass :params to the Socket constructor");
                this.params = params;
            }
            if (this.conn) {
                return;
            }
            this.conn = new this.transport(this.endPointURL());
            this.conn.timeout = this.longpollerTimeout;
            this.conn.onopen = function () { return _this.onConnOpen(); };
            this.conn.onerror = function (error) { return _this.onConnError(error); };
            this.conn.onmessage = function (event) { return _this.onConnMessage(event); };
            this.conn.onclose = function (event) { return _this.onConnClose(event); };
        };
        // Logs the message. Override `this.logger` for specialized logging. noops by default
        Socket.prototype.log = function (kind, msg, data) { this.logger(kind, msg, data); };
        // Registers callbacks for connection state change events
        //
        // Examples
        //
        //    socket.onError(function(error){ alert("An error occurred") })
        //
        Socket.prototype.onOpen = function (callback) { this.stateChangeCallbacks.open.push(callback); };
        Socket.prototype.onClose = function (callback) { this.stateChangeCallbacks.close.push(callback); };
        Socket.prototype.onError = function (callback) { this.stateChangeCallbacks.error.push(callback); };
        Socket.prototype.onMessage = function (callback) { this.stateChangeCallbacks.message.push(callback); };
        Socket.prototype.onConnOpen = function () {
            var _this = this;
            this.log("transport", "connected to " + this.endPointURL());
            this.flushSendBuffer();
            this.reconnectTimer.reset();
            if (!this.conn.skipHeartbeat) {
                clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = setInterval(function () { return _this.sendHeartbeat(); }, this.heartbeatIntervalMs);
            }
            this.stateChangeCallbacks.open.forEach(function (callback) { return callback(); });
        };
        Socket.prototype.onConnClose = function (event) {
            this.log("transport", "close", event);
            this.triggerChanError();
            clearInterval(this.heartbeatTimer);
            this.reconnectTimer.scheduleTimeout();
            this.stateChangeCallbacks.close.forEach(function (callback) { return callback(event); });
        };
        Socket.prototype.onConnError = function (error) {
            this.log("transport", error);
            this.triggerChanError();
            this.stateChangeCallbacks.error.forEach(function (callback) { return callback(error); });
        };
        Socket.prototype.triggerChanError = function () {
            this.channels.forEach(function (channel) { return channel.trigger(CHANNEL_EVENTS.error); });
        };
        Socket.prototype.connectionState = function () {
            switch (this.conn && this.conn.readyState) {
                case SOCKET_STATES.connecting: return "connecting";
                case SOCKET_STATES.open: return "open";
                case SOCKET_STATES.closing: return "closing";
                default: return "closed";
            }
        };
        Socket.prototype.isConnected = function () { return this.connectionState() === "open"; };
        Socket.prototype.remove = function (channel) {
            this.channels = this.channels.filter(function (c) { return c.joinRef() !== channel.joinRef(); });
        };
        Socket.prototype.channel = function (topic, chanParams) {
            if (chanParams === void 0) { chanParams = {}; }
            var chan = new Channel(topic, chanParams, this);
            this.channels.push(chan);
            return chan;
        };
        Socket.prototype.push = function (data) {
            var _this = this;
            var topic = data.topic, event = data.event, payload = data.payload, ref = data.ref;
            var callback = function () { return _this.conn.send(JSON.stringify(data)); };
            this.log("push", topic + " " + event + " (" + ref + ")", payload);
            if (this.isConnected()) {
                callback();
            }
            else {
                this.sendBuffer.push(callback);
            }
        };
        // Return the next message ref, accounting for overflows
        Socket.prototype.makeRef = function () {
            var newRef = this.ref + 1;
            if (newRef === this.ref) {
                this.ref = 0;
            }
            else {
                this.ref = newRef;
            }
            return this.ref.toString();
        };
        Socket.prototype.sendHeartbeat = function () {
            if (!this.isConnected()) {
                return;
            }
            this.push({ topic: "phoenix", event: "heartbeat", payload: {}, ref: this.makeRef() });
        };
        Socket.prototype.flushSendBuffer = function () {
            if (this.isConnected() && this.sendBuffer.length > 0) {
                this.sendBuffer.forEach(function (callback) { return callback(); });
                this.sendBuffer = [];
            }
        };
        Socket.prototype.onConnMessage = function (rawMessage) {
            var msg = JSON.parse(rawMessage.data);
            var topic = msg.topic, event = msg.event, payload = msg.payload, ref = msg.ref;
            this.log("receive", (payload.status || "") + " " + topic + " " + event + " " + (ref && "(" + ref + ")" || ""), payload);
            this.channels.filter(function (channel) { return channel.isMember(topic); })
                .forEach(function (channel) { return channel.trigger(event, payload, ref); });
            this.stateChangeCallbacks.message.forEach(function (callback) { return callback(msg); });
        };
        return Socket;
    }());
    phoenix.Socket = Socket;
    var LongPoll = (function () {
        function LongPoll(endPoint) {
            this.endPoint = null;
            this.token = null;
            this.skipHeartbeat = true;
            this.onopen = function () { }; // noop
            this.onerror = function () { }; // noop
            this.onmessage = function () { }; // noop
            this.onclose = function () { }; // noop
            this.readyState = SOCKET_STATES.connecting;
            this.pollEndpoint = this.normalizeEndpoint(endPoint);
            this.poll();
        }
        LongPoll.prototype.normalizeEndpoint = function (endPoint) {
            return (endPoint
                .replace("ws://", "http://")
                .replace("wss://", "https://")
                .replace(new RegExp("(.*)\/" + TRANSPORTS.websocket), "$1/" + TRANSPORTS.longpoll));
        };
        LongPoll.prototype.endpointURL = function () {
            return Ajax.appendParams(this.pollEndpoint, { token: this.token });
        };
        LongPoll.prototype.closeAndRetry = function () {
            this.close();
            this.readyState = SOCKET_STATES.connecting;
        };
        LongPoll.prototype.ontimeout = function () {
            this.onerror("timeout");
            this.closeAndRetry();
        };
        LongPoll.prototype.poll = function () {
            var _this = this;
            if (!(this.readyState === SOCKET_STATES.open || this.readyState === SOCKET_STATES.connecting)) {
                return;
            }
            Ajax.request("GET", this.endpointURL(), "application/json", null, this.timeout, this.ontimeout.bind(this), function (resp) {
                var status = 0;
                var messages = [];
                if (resp) {
                    status = resp.status;
                    messages = resp.messages;
                    _this.token = resp.token;
                }
                switch (status) {
                    case 200:
                        messages.forEach(function (msg) { return _this.onmessage({ data: JSON.stringify(msg) }); });
                        _this.poll();
                        break;
                    case 204:
                        _this.poll();
                        break;
                    case 410:
                        _this.readyState = SOCKET_STATES.open;
                        _this.onopen();
                        _this.poll();
                        break;
                    case 0:
                    case 500:
                        _this.onerror();
                        _this.closeAndRetry();
                        break;
                    default: throw ("unhandled poll status " + status);
                }
            });
        };
        LongPoll.prototype.send = function (body) {
            var _this = this;
            Ajax.request("POST", this.endpointURL(), "application/json", body, this.timeout, this.onerror.bind(this, "timeout"), function (resp) {
                if (!resp || resp.status !== 200) {
                    _this.onerror(status);
                    _this.closeAndRetry();
                }
            });
        };
        LongPoll.prototype.close = function (code, reason) {
            this.readyState = SOCKET_STATES.closed;
            this.onclose();
        };
        return LongPoll;
    }());
    phoenix.LongPoll = LongPoll;
    var Ajax = (function () {
        function Ajax() {
        }
        Ajax.request = function (method, endPoint, accept, body, timeout, ontimeout, callback) {
            if (XDomainRequest) {
                var req = new XDomainRequest(); // IE8, IE9
                this.xdomainRequest(req, method, endPoint, body, timeout, ontimeout, callback);
            }
            else {
                var req = XMLHttpRequest ?
                    new XMLHttpRequest() :
                    new ActiveXObject("Microsoft.XMLHTTP"); // IE6, IE5
                this.xhrRequest(req, method, endPoint, accept, body, timeout, ontimeout, callback);
            }
        };
        Ajax.xdomainRequest = function (req, method, endPoint, body, timeout, ontimeout, callback) {
            var _this = this;
            req.timeout = timeout;
            req.open(method, endPoint);
            req.onload = function () {
                var response = _this.parseJSON(req.responseText);
                callback && callback(response);
            };
            if (ontimeout) {
                req.ontimeout = ontimeout;
            }
            // Work around bug in IE9 that requires an attached onprogress handler
            req.onprogress = function () { };
            req.send(body);
        };
        Ajax.xhrRequest = function (req, method, endPoint, accept, body, timeout, ontimeout, callback) {
            var _this = this;
            req.timeout = timeout;
            req.open(method, endPoint, true);
            req.setRequestHeader("Content-Type", accept);
            req.onerror = function () { callback && callback(null); };
            req.onreadystatechange = function () {
                if (req.readyState === _this.states.complete && callback) {
                    var response = _this.parseJSON(req.responseText);
                    callback(response);
                }
            };
            if (ontimeout) {
                req.ontimeout = ontimeout;
            }
            req.send(body);
        };
        Ajax.parseJSON = function (resp) {
            return (resp && resp !== "") ?
                JSON.parse(resp) :
                null;
        };
        Ajax.serialize = function (obj, parentKey) {
            var queryStr = [];
            for (var key in obj) {
                if (!obj.hasOwnProperty(key)) {
                    continue;
                }
                var paramKey = parentKey ? parentKey + "[" + key + "]" : key;
                var paramVal = obj[key];
                if (typeof paramVal === "object") {
                    queryStr.push(this.serialize(paramVal, paramKey));
                }
                else {
                    queryStr.push(encodeURIComponent(paramKey) + "=" + encodeURIComponent(paramVal));
                }
            }
            return queryStr.join("&");
        };
        Ajax.appendParams = function (url, params) {
            if (Object.keys(params).length === 0) {
                return url;
            }
            var prefix = url.match(/\?/) ? "&" : "?";
            return "" + url + prefix + this.serialize(params);
        };
        Ajax.states = { complete: 4 };
        return Ajax;
    }());
    var Presence = (function () {
        function Presence() {
        }
        Presence.syncState = function (currentState, newState, onJoin, onLeave) {
            var _this = this;
            var state = this.clone(currentState);
            var joins = {};
            var leaves = {};
            this.map(state, function (key, presence) {
                if (!newState[key]) {
                    leaves[key] = presence;
                }
            });
            this.map(newState, function (key, newPresence) {
                var currentPresence = state[key];
                if (currentPresence) {
                    var newRefs_1 = newPresence.metas.map(function (m) { return m.phx_ref; });
                    var curRefs_1 = currentPresence.metas.map(function (m) { return m.phx_ref; });
                    var joinedMetas = newPresence.metas.filter(function (m) { return curRefs_1.indexOf(m.phx_ref) < 0; });
                    var leftMetas = currentPresence.metas.filter(function (m) { return newRefs_1.indexOf(m.phx_ref) < 0; });
                    if (joinedMetas.length > 0) {
                        joins[key] = newPresence;
                        joins[key].metas = joinedMetas;
                    }
                    if (leftMetas.length > 0) {
                        leaves[key] = _this.clone(currentPresence);
                        leaves[key].metas = leftMetas;
                    }
                }
                else {
                    joins[key] = newPresence;
                }
            });
            return this.syncDiff(state, { joins: joins, leaves: leaves }, onJoin, onLeave);
        };
        Presence.syncDiff = function (currentState, _a, onJoin, onLeave) {
            var joins = _a.joins, leaves = _a.leaves;
            var state = this.clone(currentState);
            if (!onJoin) {
                onJoin = function () { };
            }
            if (!onLeave) {
                onLeave = function () { };
            }
            this.map(joins, function (key, newPresence) {
                var currentPresence = state[key];
                state[key] = newPresence;
                if (currentPresence) {
                    (_a = state[key].metas).unshift.apply(_a, currentPresence.metas);
                }
                onJoin(key, currentPresence, newPresence);
                var _a;
            });
            this.map(leaves, function (key, leftPresence) {
                var currentPresence = state[key];
                if (!currentPresence) {
                    return;
                }
                var refsToRemove = leftPresence.metas.map(function (m) { return m.phx_ref; });
                currentPresence.metas = currentPresence.metas.filter(function (p) {
                    return refsToRemove.indexOf(p.phx_ref) < 0;
                });
                onLeave(key, currentPresence, leftPresence);
                if (currentPresence.metas.length === 0) {
                    delete state[key];
                }
            });
            return state;
        };
        Presence.list = function (presences, chooser) {
            if (!chooser) {
                chooser = function (key, pres) { return pres; };
            }
            return this.map(presences, function (key, presence) {
                return chooser(key, presence);
            });
        };
        // private
        Presence.map = function (obj, func) {
            return Object.getOwnPropertyNames(obj).map(function (key) { return func(key, obj[key]); });
        };
        Presence.clone = function (obj) { return JSON.parse(JSON.stringify(obj)); };
        return Presence;
    }());
    phoenix.Presence = Presence;
    ;
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
    var Timer = (function () {
        function Timer(callback, timerCalc) {
            this.callback = callback;
            this.timerCalc = timerCalc;
            this.timer = null;
            this.tries = 0;
        }
        Timer.prototype.reset = function () {
            this.tries = 0;
            clearTimeout(this.timer);
        };
        // Cancels any previous scheduleTimeout and schedules callback
        Timer.prototype.scheduleTimeout = function () {
            var _this = this;
            clearTimeout(this.timer);
            this.timer = setTimeout(function () {
                _this.tries = _this.tries + 1;
                _this.callback();
            }, this.timerCalc(this.tries + 1));
        };
        return Timer;
    }());
    phoenix.Timer = Timer;
})(phoenix || (phoenix = {}));
module.exports = phoenix;
