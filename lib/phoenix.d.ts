declare namespace phoenix {
    class Push {
        private channel;
        private event;
        private payload;
        private receivedResp;
        private timeoutTimer;
        private recHooks;
        private sent;
        private refEvent;
        ref: string;
        timeout: number;
        constructor(channel: Channel, event: string, payload: any, timeout: number);
        resend(timeout: number): void;
        send(): void;
        receive(status: string, callback: (response?: any) => void): Push;
        matchReceive({status, response, ref}: {
            status: any;
            response: any;
            ref: any;
        }): void;
        cancelRefEvent(): void;
        cancelTimeout(): void;
        startTimeout(): void;
        hasReceived(status: string): boolean;
        trigger(status: string, response: any): void;
    }
    interface ChannelBinding {
        event: string;
        callback: (payload?: any, ref?: string) => void;
    }
    class Channel {
        state: string;
        topic: string;
        params: Object;
        socket: Socket;
        bindings: ChannelBinding[];
        timeout: number;
        joinedOnce: boolean;
        joinPush: Push;
        pushBuffer: any[];
        rejoinTimer: Timer;
        constructor(topic: string, params: Object, socket: Socket);
        rejoinUntilConnected(): void;
        join(timeout?: number): Push;
        onClose(callback: () => void): void;
        onError(callback: (reason: string) => void): void;
        on(event: string, callback: (payload?: any, ref?: string) => void): void;
        off(event: string): void;
        canPush(): boolean;
        push(event: string, payload: any, timeout?: number): Push;
        leave(timeout?: number): Push;
        onMessage(event: string, payload: any, ref: string): any;
        isMember(topic: string): boolean;
        joinRef(): string;
        sendJoin(timeout: number): void;
        rejoin(timeout?: number): void;
        trigger(event: string, payload?: any, ref?: string): void;
        replyEventName(ref: string): string;
        isClosed(): boolean;
        isErrored(): boolean;
        isJoined(): boolean;
        isJoining(): boolean;
        isLeaving(): boolean;
    }
    interface SocketOptions {
        timeout?: number;
        transport?: any;
        heartbeatIntervalMs?: number;
        reconnectAfterMs?: (tries: number) => number;
        logger?: any;
        longpollerTimeout?: number;
        params?: any;
    }
    class Socket {
        stateChangeCallbacks: {
            open: any[];
            close: any[];
            error: any[];
            message: any[];
        };
        channels: Channel[];
        sendBuffer: any[];
        ref: number;
        timeout: number;
        transport: any;
        heartbeatTimer: number;
        heartbeatIntervalMs: number;
        reconnectAfterMs: (tries: number) => number;
        logger: any;
        longpollerTimeout: number;
        params: any;
        endPoint: string;
        reconnectTimer: Timer;
        conn: any;
        constructor(endPoint: string, opts: SocketOptions);
        protocol(): string;
        endPointURL(): string;
        disconnect(callback?: any, code?: number, reason?: string): void;
        connect(params?: any): void;
        log(kind: string, msg: string, data?: any): void;
        onOpen(callback: any): void;
        onClose(callback: any): void;
        onError(callback: any): void;
        onMessage(callback: any): void;
        onConnOpen(): void;
        onConnClose(event: string): void;
        onConnError(error: string): void;
        triggerChanError(): void;
        connectionState(): string;
        isConnected(): boolean;
        remove(channel: Channel): void;
        channel(topic: string, chanParams?: {}): Channel;
        push(data: {
            topic: string;
            event: string;
            payload: any;
            ref: string;
        }): void;
        makeRef(): string;
        sendHeartbeat(): void;
        flushSendBuffer(): void;
        onConnMessage(rawMessage: {
            data: string;
        }): void;
    }
    class LongPoll {
        endPoint: string;
        pollEndpoint: string;
        token: string;
        skipHeartbeat: boolean;
        onopen: () => void;
        onerror: (reason?: string) => void;
        onmessage: (message: {
            data: string;
        }) => void;
        onclose: () => void;
        readyState: number;
        timeout: number;
        constructor(endPoint: string);
        normalizeEndpoint(endPoint: string): string;
        endpointURL(): string;
        closeAndRetry(): void;
        ontimeout(): void;
        poll(): void;
        send(body: any): void;
        close(code?: number, reason?: string): void;
    }
    class Presence {
        static syncState(currentState: any, newState: any, onJoin: (key: any, currentPresence: any, newPresence: any) => void, onLeave: (key: any, currentPresence: any, leftPresence: any) => void): any;
        static syncDiff(currentState: any, {joins, leaves}: {
            joins: any;
            leaves: any;
        }, onJoin: (key: any, currentPresence: any, newPresence: any) => void, onLeave: (key: any, currentPresence: any, leftPresence: any) => void): any;
        static list(presences: any[], chooser: (key: any, pres: any) => any): void[];
        static map(obj: any, func: (key: any, value: any) => void): void[];
        static clone(obj: any): any;
    }
    class Timer {
        private callback;
        private timerCalc;
        private timer;
        private tries;
        constructor(callback: () => void, timerCalc: (tries: number) => number);
        reset(): void;
        scheduleTimeout(): void;
    }
}
export = phoenix;
